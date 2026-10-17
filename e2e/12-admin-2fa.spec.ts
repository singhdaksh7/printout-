import { execFileSync } from 'node:child_process';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { base32Decode, hotp, timeStep } from '../apps/api/src/two-factor/totp';
import { DB_URL, ROOT } from './env';
import { VIEWPORTS, expectNoOverflow, newMobileContext, shot } from './support';

// Admin two-step verification in a real browser: enrollment, sign-in challenge, recovery code, disable. Uses dedicated admins
// created through the bootstrap CLI (the shared seed admin is never touched) and codes computed from the on-screen setup key.

const PASSWORD = 'e2e-twofactor-passphrase-1';

function createAdmin(email: string) {
  execFileSync('node', ['--import', 'tsx', 'prisma/bootstrap-admin.ts'], {
    cwd: path.join(ROOT, 'apps', 'api'),
    env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: 'development', ADMIN_EMAIL: email, ADMIN_PASSWORD: PASSWORD },
    stdio: 'pipe'
  });
}

async function scan(page: Page, label: string, scope = 'body') {
  const results = await new AxeBuilder({ page }).include(scope).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe violations on ${label}\n${summary.join('\n')}`).toEqual([]);
}

/** Code for a given offset from now (offset 1 is inside the accepted skew window and later than any code already used). */
const codeAt = (secret: Buffer, offset: number) => hotp(secret, timeStep(Date.now()) + offset);

async function passwordStep(page: Page, email: string) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function enroll(page: Page): Promise<{ secret: Buffer; codes: string[] }> {
  await page.goto('/admin/account');
  const card = page.getByRole('region', { name: 'Two-step verification' });
  await card.getByRole('button', { name: 'Set up two-step verification' }).click();
  const reauth = page.getByRole('region', { name: 'Turn on two-step verification' });
  await expect(reauth.getByLabel('Current password', { exact: true })).toBeFocused();
  await scan(page, 'enroll: password', '#pb-main');
  await reauth.getByLabel('Current password', { exact: true }).fill(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('img', { name: /QR code for adding Printout Buddy/ })).toBeVisible();
  await page.getByText("Can't scan?").click();
  const key = (await page.getByLabel('Setup key').innerText()).replace(/\s/g, '');
  const secret = base32Decode(key);
  await scan(page, 'enroll: QR + manual key', '#pb-main');
  await page.getByLabel('Authentication code').fill(codeAt(secret, 0));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Save your recovery codes now' })).toBeFocused();
  const codes = await page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').allInnerTexts();
  expect(codes).toHaveLength(10);
  await scan(page, 'enroll: recovery codes', '#pb-main');
  const done = page.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();
  await page.getByLabel('I have saved these recovery codes in a safe place').check();
  await done.click();
  await expect(card.getByText('On', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(codes[0]!);
  await expect(page.locator('body')).not.toContainText(key);
  return { secret, codes };
}

test.describe('admin two-step verification', () => {
  test('desktop: enroll, sign in with a code, replayed code refused, recovery code, regenerate, disable', async ({ page }) => {
    const email = 'twofactor-desktop@printout.test';
    createAdmin(email);
    await page.setViewportSize(VIEWPORTS.desktop);
    await passwordStep(page, email);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    const { secret, codes } = await enroll(page);
    await shot(page, '91-admin-2fa-enabled');

    // Sign out, then password -> code step (keyboard only), focus on the code field.
    await page.getByRole('region', { name: 'Current session' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible();
    await passwordStep(page, email);
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await expect(page.getByLabel('Authentication code')).toBeFocused();
    await scan(page, 'login code step');
    await shot(page, '92-admin-2fa-login');
    expect(await page.context().cookies()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'printout_session' })]));

    // The enrollment code was already used: it must be refused, with a clear error and focus back on the field.
    await page.getByLabel('Authentication code').fill(codeAt(secret, 0));
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByText(/That code is not valid/)).toBeVisible();
    await expect(page.getByLabel('Authentication code')).toBeFocused();
    await scan(page, 'login code step with error');
    // A pending sign-in grants nothing.
    const pending = await page.request.get('/api/v1/admin/account');
    expect(pending.status()).toBe(401);

    // The next time-step's code is inside the accepted window and newer than the one used.
    await page.getByLabel('Authentication code').fill(codeAt(secret, 1));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    // Recovery code on a fresh sign-in; the code works once.
    await page.request.post('/api/v1/auth/logout', { headers: { 'x-csrf-token': (await (await page.request.get('/api/v1/auth/session')).json()).data.csrfToken } });
    await passwordStep(page, email);
    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery code').fill(codes[0]!);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();
    await expect(page.getByText(/You signed in with a recovery code\. 9 recovery codes left/)).toBeVisible();
    await scan(page, 'account after recovery sign-in', '#pb-main');

    // Disable with a second recovery code (password + code), after which sign-in needs the password only.
    const card = page.getByRole('region', { name: 'Two-step verification' });
    await expect(card.getByText('9', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Turn off' }).click();
    const off = page.getByRole('region', { name: 'Turn off two-step verification' });
    await off.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await off.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await off.getByLabel('Recovery code').fill(codes[1]!);
    await off.getByRole('button', { name: 'Turn off two-step verification' }).click();
    await expect(page.getByText('Two-step verification is off.')).toBeVisible();
    await page.getByRole('region', { name: 'Current session' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible();
    await passwordStep(page, email);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test('mobile: code step and enrollment fit a phone, are accessible and have no horizontal overflow', async ({ browser }) => {
    const email = 'twofactor-mobile@printout.test';
    createAdmin(email);
    for (const vp of [VIEWPORTS.s360, VIEWPORTS.mobile]) {
      const context = await newMobileContext(browser, vp);
      const page = await context.newPage();
      await passwordStep(page, email);
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' }).or(page.getByRole('heading', { name: 'Two-step verification' }))).toBeVisible();
      if (await page.getByRole('heading', { level: 1, name: 'Dashboard' }).isVisible()) {
        await page.goto('/admin/account');
        await page.getByRole('button', { name: 'Set up two-step verification' }).click();
        await page.getByRole('region', { name: 'Turn on two-step verification' }).getByLabel('Current password', { exact: true }).fill(PASSWORD);
        await page.keyboard.press('Enter');
        await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
        await expectNoOverflow(page, `enroll ${vp.width}`);
        await scan(page, `enroll mobile ${vp.width}`, '#pb-main');
        await shot(page, `93-admin-2fa-enroll-${vp.width}`);
        const box = await page.getByRole('img', { name: /QR code/ }).boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(150);
      }
      else {
        await expect(page.getByLabel('Authentication code')).toBeFocused();
        await expectNoOverflow(page, `code step ${vp.width}`);
        await scan(page, `code step mobile ${vp.width}`);
        await shot(page, `94-admin-2fa-code-${vp.width}`);
      }
      await context.close();
    }
  });
});
