import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SEED_PASSWORD } from './env';
import { SLUG, VIEWPORTS, createOrderViaApi, expectNoOverflow, makePdf, newMobileContext, uiLogin } from './support';

// UI polish: the customer app on the shared navy/orange system, scoped link styles, the phone "More" navigation, the Sound switch and
// the New-tab queue table. Real browser, isolated e2e database; business behaviour is covered by the other specs.

async function scan(page: Page, label: string, include?: string) {
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  const results = await (include ? builder.include(include) : builder).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe violations on ${label}\n${summary.join('\n')}`).toEqual([]);
}

const seg = (page: Page, name: string) => page.locator('label.pb-seg__opt', { hasText: name });

const WIDTHS = [
  ['360', VIEWPORTS.s360],
  ['390', VIEWPORTS.mobile],
  ['768', VIEWPORTS.tablet],
  ['1440', VIEWPORTS.desktop]
] as const;

for (const [name, vp] of WIDTHS) {
  test(`customer pages @ ${name}px: navy/orange system, accessible, no overflow`, async ({ browser }) => {
    const order = await createOrderViaApi(SLUG, { name: `Polish ${name}` });
    const ctx = await newMobileContext(browser, vp);
    const page = await ctx.newPage();
    await page.goto(`/p/${SLUG}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Central Print' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectNoOverflow(page, `customer idle ${name}`);
    await scan(page, `customer idle ${name}`);

    // the primary action is the approved orange with a navy label, in the approved body font; no legacy blue anywhere
    const choose = page.getByRole('button', { name: 'Choose file' });
    expect(await choose.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(232, 119, 46)');
    expect(await choose.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(20, 33, 61)');
    expect(await page.locator('.cx-root').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('DM Sans');
    expect(await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => /29, 78, 216/.test(getComputedStyle(e).backgroundColor + getComputedStyle(e).color + getComputedStyle(e).borderTopColor)).length)).toBe(0);

    await page.getByTestId('file-input').setInputFiles({ name: 'polish.pdf', mimeType: 'application/pdf', buffer: await makePdf(4) });
    await expect(page.getByTestId('total')).toBeVisible();
    await seg(page, 'Custom').click();
    await page.getByPlaceholder(/e\.g\./).fill('4-1');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expectNoOverflow(page, `customer configured ${name}`);
    await scan(page, `customer configured ${name}`);
    // every segmented option and button on the phone layouts keeps a 44px touch area
    if (name !== '1440' && name !== '768') {
      for (const label of ['Black & white', 'Single-sided', 'All pages']) {
        const box = await seg(page, label).boundingBox();
        expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44);
      }
    }

    await page.goto(`/t/${order.trackingToken}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Order');
    await page.evaluate(() => document.fonts.ready);
    await expectNoOverflow(page, `tracking ${name}`);
    await scan(page, `tracking ${name}`);
    // the current timeline step uses the brand orange
    expect(await page.locator('.is-current .cx-dot').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(232, 119, 46)');

    await page.goto('/p/no-such-shop');
    await expect(page.getByRole('heading', { level: 1, name: 'Shop not found' })).toBeVisible();
    await expectNoOverflow(page, `not found ${name}`);
    await scan(page, `not found ${name}`);
    await ctx.close();
  });
}

test('links inside the shop and admin areas read as links (orange-ink, underlined) with a visible focus ring', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill('admin@printout.test');
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const link = page.getByRole('link', { name: 'All orders' });
  const style = await link.evaluate((el) => { const c = getComputedStyle(el); return { color: c.color, decoration: c.textDecorationLine }; });
  expect(style).toEqual({ color: 'rgb(176, 78, 23)', decoration: 'underline' });
  for (let i = 0; i < 60 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab'); // keyboard focus, so :focus-visible applies
  expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  expect(await link.evaluate((el) => getComputedStyle(el).outlineColor)).toBe('rgb(36, 86, 201)');
  await scan(page, 'admin dashboard', '#pb-main');
});

test.describe('shop UI', () => {
  test('phone tab bar: five destinations plus an accessible More sheet that reaches QR & standee and Settings', async ({ browser }) => {
    const ctx = await newMobileContext(browser, VIEWPORTS.s360);
    const page = await ctx.newPage();
    await uiLogin(page, 'owner@central.test');
    const bar = page.getByRole('navigation', { name: 'Shop sections, phone' });
    await expect(bar).toBeVisible();
    for (const label of ['Queue', 'History', 'Analytics', 'Devices', 'Rate card']) await expect(bar.getByRole('link', { name: label })).toBeVisible();
    await expectNoOverflow(page, 'phone tab bar 360');
    const tabs = await bar.locator('li').evaluateAll((els) => els.map((e) => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
    expect(tabs).toHaveLength(6);
    for (const t of tabs) { expect(t.w).toBeGreaterThanOrEqual(56); expect(t.h).toBeGreaterThanOrEqual(44); }

    // keyboard: open, focus moves into the sheet, Escape closes and returns focus to the button
    const more = bar.getByRole('button', { name: 'More' });
    await more.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.waitForTimeout(350);
    await scan(page, 'More sheet', '.pb-sheet');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(more).toBeFocused();

    await more.click();
    await sheet.getByRole('link', { name: 'QR & standee' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Counter QR' })).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await expect(more).toHaveClass(/is-active/);
    await more.click();
    await sheet.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await ctx.close();
  });

  test('queue: Sound is a switch that persists, and the New tab has no empty Status column', async ({ page }) => {
    await createOrderViaApi(SLUG, { name: 'Switch check' });
    await page.setViewportSize(VIEWPORTS.desktop);
    await uiLogin(page, 'owner@central.test');
    await expect(page.getByTestId('order-card').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Status' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Settings' })).toBeVisible();
    const sound = page.getByRole('switch', { name: 'Sound for new orders' });
    await expect(sound).not.toBeChecked();
    await page.getByText('Sound for new orders').click();
    await expect(sound).toBeChecked();
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Sound for new orders' })).toBeChecked();
    await page.getByRole('switch', { name: 'Sound for new orders' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('switch', { name: 'Sound for new orders' })).not.toBeChecked();
    // settings never wrap with a dangling separator: two fixed lines per row
    const lines = await page.getByTestId('order-specs').first().locator('.pb-settings__line').count();
    expect(lines).toBe(2);
    await scan(page, 'queue desktop', '#pb-main');
  });
});

test('admin phone: More offers Subscriptions, Plans and Account; the header stays on one row', async ({ browser }) => {
  const ctx = await newMobileContext(browser, VIEWPORTS.s360);
  const page = await ctx.newPage();
  await page.goto('/admin/login');
  await expect(page.getByRole('img', { name: 'PrintoutBuddy' }).first()).toBeVisible();
  await page.getByLabel('Email').fill('admin@printout.test');
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const header = await page.locator('.pb-topbar').boundingBox();
  expect(header!.height).toBeLessThan(80);
  await expectNoOverflow(page, 'admin header 360');
  const bar = page.getByRole('navigation', { name: 'Admin sections, phone' });
  await bar.getByRole('button', { name: 'More' }).click();
  const sheet = page.getByRole('dialog', { name: 'More' });
  for (const label of ['Subscriptions', 'Plans', 'Account']) await expect(sheet.getByRole('link', { name: label })).toBeVisible();
  await sheet.getByRole('link', { name: 'Account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();
  await expectNoOverflow(page, 'admin account 360');
  await scan(page, 'admin account 360', '#pb-main');
  await ctx.close();
});
