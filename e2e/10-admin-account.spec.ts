import { execFileSync } from 'node:child_process';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, ROOT } from './env';
import { VIEWPORTS, expectNoOverflow, newMobileContext, shot } from './support';

// Platform-admin Account Settings in a real browser: accessibility (axe, WCAG 2.1 A/AA), keyboard use, focus, phone widths and
// the session-expiry behaviour after a credential change. Uses dedicated admins created through the production bootstrap CLI, so
// the shared seed admin (admin@printout.test) that other specs sign in with is never modified.

const PASSWORD = 'e2e-account-passphrase-1';
const NEXT_PASSWORD = 'e2e-account-passphrase-2-changed';

function createAdmin(email: string) {
  execFileSync('node', ['--import', 'tsx', 'prisma/bootstrap-admin.ts'], {
    cwd: path.join(ROOT, 'apps', 'api'),
    env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: 'development', ADMIN_EMAIL: email, ADMIN_PASSWORD: PASSWORD },
    stdio: 'pipe'
  });
}

async function adminLogin(page: Page, email: string, password = PASSWORD, expectSuccess = true) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (expectSuccess) await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

async function scan(page: Page, label: string, scope = '#pb-main') {
  const results = await new AxeBuilder({ page }).include(scope).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe violations on ${label}\n${summary.join('\n')}`).toEqual([]);
}

const emailRegion = (page: Page) => page.getByRole('region', { name: 'Change email' });
const passwordRegion = (page: Page) => page.getByRole('region', { name: 'Change password' });

test.describe('admin account settings', () => {
  test('desktop: reachable from the sidebar, accessible, keyboard-operable, focus moves to errors', async ({ page }) => {
    const email = 'account-desktop@printout.test';
    createAdmin(email);
    await page.setViewportSize(VIEWPORTS.desktop);
    await adminLogin(page, email);
    await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Account settings for/ })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await scan(page, 'account desktop');
    await shot(page, '90-admin-account-desktop');

    // Validation errors: focus lands on the first invalid field and the error is exposed to assistive tech.
    await passwordRegion(page).getByRole('button', { name: 'Change password' }).click();
    const current = passwordRegion(page).getByLabel('Current password', { exact: true });
    await expect(current).toBeFocused();
    await expect(current).toHaveAttribute('aria-invalid', 'true');
    await expect(passwordRegion(page).getByText('Enter your current password.')).toBeVisible();
    await scan(page, 'account desktop with validation errors');

    // Keyboard only: type, Tab to the Show toggle, Space to reveal, Tab on to the next field.
    await current.fill('some-current-password');
    await page.keyboard.press('Tab');
    const toggle = passwordRegion(page).getByRole('button', { name: 'Show current password' });
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(current).toHaveAttribute('type', 'text');
    await expect(passwordRegion(page).getByRole('button', { name: 'Hide current password' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(passwordRegion(page).getByLabel('New password', { exact: true })).toBeFocused();

    // Wrong current password reported by the server: error on the field, focus returned to it, user stays signed in.
    await passwordRegion(page).getByLabel('New password', { exact: true }).fill('a-perfectly-fine-new-pass-7');
    await passwordRegion(page).getByLabel('Confirm new password', { exact: true }).fill('a-perfectly-fine-new-pass-7');
    await passwordRegion(page).getByRole('button', { name: 'Change password' }).click();
    await expect(passwordRegion(page).getByText('Current password is incorrect.')).toBeVisible();
    await expect(current).toBeFocused();
    await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();
    await scan(page, 'account desktop with server error');

    // Email confirmation, then the generic duplicate-email message (the seeded shop owner exists).
    await emailRegion(page).getByLabel('New email', { exact: true }).fill('owner@central.test');
    await emailRegion(page).getByLabel('Confirm new email', { exact: true }).fill('owner@central.tset');
    await emailRegion(page).getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await emailRegion(page).getByRole('button', { name: 'Change email' }).click();
    await expect(emailRegion(page).getByText('The email addresses do not match.')).toBeVisible();
    await expect(emailRegion(page).getByLabel('Confirm new email', { exact: true })).toBeFocused();
    await emailRegion(page).getByLabel('Confirm new email', { exact: true }).fill('owner@central.test');
    await emailRegion(page).getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await emailRegion(page).getByRole('button', { name: 'Change email' }).click();
    await expect(emailRegion(page).getByText('This email address cannot be used. Choose a different one.')).toBeVisible();
    await expect(emailRegion(page).getByLabel('New email', { exact: true })).toBeFocused();
    await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();
  });

  for (const [name, vp] of [['360', VIEWPORTS.s360], ['390', VIEWPORTS.mobile], ['768', VIEWPORTS.tablet]] as const) {
    test(`responsive ${name}px: no horizontal overflow, accessible, reachable from the top bar`, async ({ browser }) => {
      const email = `account-${name}@printout.test`;
      createAdmin(email);
      const ctx = await newMobileContext(browser, vp);
      const page = await ctx.newPage();
      await adminLogin(page, email);
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
      await page.getByRole('link', { name: /Account settings for/ }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();
      await expect(page.getByText(email, { exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expectNoOverflow(page, `admin account ${name}`);
      await scan(page, `account ${name}`);
      await passwordRegion(page).getByLabel('New password', { exact: true }).fill('x'.repeat(40));
      await passwordRegion(page).getByRole('button', { name: 'Show new password' }).click();
      await expectNoOverflow(page, `admin account revealed ${name}`);
      await passwordRegion(page).getByRole('button', { name: 'Change password' }).click();
      await expect(passwordRegion(page).getByText('Enter your current password.')).toBeVisible();
      await expectNoOverflow(page, `admin account errors ${name}`);
      await shot(page, `91-admin-account-${name}`);
      await ctx.close();
    });
  }

  test('changing the password ends every session, including other devices, and the old password stops working', async ({ browser }) => {
    const email = 'account-password@printout.test';
    createAdmin(email);
    const a = await (await browser.newContext({ viewport: VIEWPORTS.desktop })).newPage();
    const b = await (await browser.newContext({ viewport: VIEWPORTS.desktop })).newPage();
    await adminLogin(a, email);
    await adminLogin(b, email);
    await b.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Account' }).click();
    await expect(b.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();

    await a.goto('/admin/account');
    await expect(a.getByText('Other active sessions')).toBeVisible();
    await expect(a.locator('dt:has-text("Other active sessions") + dd')).toHaveText('1');
    await passwordRegion(a).getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await passwordRegion(a).getByLabel('New password', { exact: true }).fill(NEXT_PASSWORD);
    await passwordRegion(a).getByLabel('Confirm new password', { exact: true }).fill(NEXT_PASSWORD);
    await passwordRegion(a).getByRole('button', { name: 'Change password' }).click();

    // Device A: signed out with an explanation; protected pages now require sign-in.
    await expect(a.getByRole('heading', { level: 1, name: 'Admin sign in' })).toBeVisible();
    await expect(a.getByRole('status').filter({ hasText: 'password was changed' })).toBeVisible();
    await scan(a, 'sign-in after password change', 'form');
    await a.goto('/admin/account');
    await expect(a).toHaveURL(/\/admin\/login/);

    // Device B: its next request is rejected and it is sent to sign in as an expired session.
    await b.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Shops' }).click();
    await expect(b.getByRole('heading', { level: 1, name: 'Admin sign in' })).toBeVisible();
    await expect(b.getByText('Session expired — sign in again.')).toBeVisible();

    // Old password is rejected, the new one works.
    await adminLogin(a, email, PASSWORD, false);
    await expect(a.getByText('Incorrect email or password.')).toBeVisible();
    // Sign-in returns to the page the admin came from (/admin/account), which is the intended behaviour.
    await adminLogin(a, email, NEXT_PASSWORD, false);
    await expect(a.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();
  });

  test('changing the email signs out and the new address signs in', async ({ page }) => {
    const email = 'account-email@printout.test';
    const renamed = 'account-email-renamed@printout.test';
    createAdmin(email);
    await adminLogin(page, email);
    await page.goto('/admin/account');
    await emailRegion(page).getByLabel('New email', { exact: true }).fill(renamed);
    await emailRegion(page).getByLabel('Confirm new email', { exact: true }).fill(renamed);
    await emailRegion(page).getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await emailRegion(page).getByRole('button', { name: 'Change email' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Admin sign in' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'email was changed' })).toBeVisible();
    await adminLogin(page, email, PASSWORD, false);
    await expect(page.getByText('Incorrect email or password.')).toBeVisible();
    await adminLogin(page, renamed);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await page.goto('/admin/account');
    await expect(page.getByText(renamed, { exact: true })).toBeVisible();
  });

  test('the audit log records the change as metadata only', async ({ page }) => {
    const email = 'account-audit@printout.test';
    createAdmin(email);
    await adminLogin(page, email);
    await page.goto('/admin/account');
    await passwordRegion(page).getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await passwordRegion(page).getByLabel('New password', { exact: true }).fill(NEXT_PASSWORD);
    await passwordRegion(page).getByLabel('Confirm new password', { exact: true }).fill(NEXT_PASSWORD);
    await passwordRegion(page).getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Admin sign in' })).toBeVisible();
    await adminLogin(page, email, NEXT_PASSWORD);
    await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByText('admin.account.password_changed').first()).toBeVisible();
    const body = await page.locator('#pb-main').innerText();
    expect(body).not.toContain(NEXT_PASSWORD);
    expect(body).not.toContain(PASSWORD);
  });
});
