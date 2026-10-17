import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { API } from './env';
import { ART, VIEWPORTS, createOrderViaApi, dbQuery, expectNoOverflow, jfetch, makePdf, newMobileContext, uiLogin as rawLogin, uploadViaApi } from './support';

// Operating hours, end to end. Uses the Metro Copies shop only (other specs use Central) and restores it at the end.
const SLUG = 'metro-copies';
const OWNER = 'owner@metro.test';

/** Signs in and waits until the shop shell has replaced the sign-in form. */
async function uiLogin(page: Page, email: string) {
  await rawLogin(page, email);
  await page.waitForURL((u) => !u.pathname.includes('/login'));
  await expect(page.locator('#pb-main')).toBeVisible();
}
const snap = (page: Page, name: string) => page.screenshot({ path: path.join(ART, `hours-${name}.png`), fullPage: true });
async function scan(page: Page, label: string, scope = '#pb-main') {
  const results = await new AxeBuilder({ page }).include(scope).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe violations on ${label}\n${summary.join('\n')}`).toEqual([]);
}
const reset = () => dbQuery(`update "ShopSettings" set "operatingHours" = null, "specialClosures" = '[]', "temporaryClosure" = null, "reopenUntil" = null, "afterHoursPolicy" = 'ACCEPT', timezone = 'Asia/Kolkata' where "shopId" = (select id from "Shop" where slug = '${SLUG}')`);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const week = (iv: { start: string; end: string }[]) => Object.fromEntries(DAYS.map((d) => [d, iv]));
const setHours = (json: unknown, policy: 'ACCEPT' | 'BLOCK') =>
  dbQuery(`update "ShopSettings" set "operatingHours" = '${JSON.stringify(json)}'::jsonb, "afterHoursPolicy" = '${policy}' where "shopId" = (select id from "Shop" where slug = '${SLUG}')`);

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => { reset(); });
test.afterAll(() => { reset(); });

test('shopkeeper configures hours, holiday, policy; customer sees them; blocked orders are rejected by the API', async ({ page, browser }) => {
  await uiLogin(page, OWNER);
  await page.goto('/shop/settings');
  const section = page.getByRole('region', { name: 'Operating hours' });
  await expect(section.getByRole('status', { name: 'Current shop status' })).toContainText('Opening hours not set');

  // Weekly schedule: starts from the Mon-Sat 9-6 default; keyboard-operable switches; Sunday stays closed.
  await section.getByRole('switch', { name: 'Use a weekly schedule' }).check();
  await expect(section.getByLabel('Monday opens')).toHaveValue('09:00');
  await section.getByLabel('Monday opens').fill('08:30');
  await section.getByLabel('Monday closes').fill('20:00');
  await section.getByRole('switch', { name: 'Tuesday open' }).focus();
  await page.keyboard.press('Space'); // default week is Mon-Sat open: Space closes Tuesday
  await expect(section.getByLabel('Tuesday opens')).toHaveCount(0);
  await page.keyboard.press('Space'); // and reopens it with the hours it had
  await expect(section.getByLabel('Tuesday opens')).toBeVisible();
  await section.getByRole('button', { name: 'Open 24 hours on Tuesday' }).click();
  await expect(section.getByText('Open 24 hours').first()).toBeVisible();

  // Invalid (overlap) is rejected client side with an alert.
  await section.getByRole('button', { name: 'Add hours for Monday' }).click();
  await section.getByLabel('Monday opens (2)').fill('10:00');
  await section.getByRole('button', { name: 'Save operating hours' }).click();
  await expect(section.getByRole('alert').filter({ hasText: /overlap/ })).toBeVisible();
  await section.getByRole('button', { name: 'Remove Monday interval 2' }).click();

  // Holiday and policy.
  await section.getByLabel('Closure date').fill('2031-01-26');
  await section.getByLabel('Reason (optional)').fill('Republic Day');
  await section.getByRole('button', { name: 'Add closed date' }).click();
  await expect(section.getByRole('list', { name: 'Closed dates' })).toContainText('Republic Day');
  await section.getByRole('radio', { name: /Do not accept new orders/ }).check();
  await snap(page, 'shop-editor-desktop');
  await section.getByRole('button', { name: 'Save operating hours' }).click();
  await expect(page.getByText('Operating hours saved')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Operating hours' }).getByLabel('Monday opens')).toHaveValue('08:30');
  await expect(page.getByRole('region', { name: 'Operating hours' }).getByRole('radio', { name: /Do not accept new orders/ })).toBeChecked();
  await scan(page, 'settings with hours');

  // Customer page shows status from the server and weekly hours.
  const cust = await (await newMobileContext(browser, VIEWPORTS.mobile)).newPage();
  await cust.goto(`/p/${SLUG}`);
  const panel = cust.getByRole('region', { name: 'Opening hours' });
  await expect(panel).toBeVisible();
  await panel.getByText('Weekly hours').click();
  await expect(panel.getByRole('row', { name: /Tuesday.*Open 24 hours/ })).toBeVisible();
  await expect(panel.getByRole('row', { name: /Sunday.*Closed/ })).toBeVisible();
  await expect(panel.getByText('Upcoming closures')).toHaveCount(0); // 2031 is beyond the 60-day window
  await snap(cust, 'customer-mobile');
  await scan(cust, 'customer hours', 'main');
  await cust.context().close();
});

test('closed + BLOCK: customer cannot upload or order (API enforced); tracking of existing orders still works; ACCEPT lets orders through', async ({ browser }) => {
  reset();
  const existing = await createOrderViaApi(SLUG, { name: 'before closing', fileName: 'hours-before.pdf' });
  // Prepare a document + quote while open, then close the shop between quote and order (boundary).
  const doc = await uploadViaApi(SLUG, await makePdf(2), 'hours-boundary.pdf');
  const quote = await jfetch(`${API}/api/v1/public/shops/${SLUG}/quotes`, { method: 'POST', json: { documentId: doc.documentId, printOptions: { paperSize: 'A4', colourMode: 'bw', sides: 'single', copies: 1, pageSelection: { mode: 'all' } } } });
  expect(quote.status).toBe(200);

  setHours(week([]), 'BLOCK'); // closed every day
  const blocked = await jfetch(`${API}/api/v1/public/shops/${SLUG}/orders`, { method: 'POST', json: { quoteId: quote.body.data.quoteId, clientRequestId: crypto.randomUUID() } });
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.code).toBe('SHOP_CLOSED');
  const init = await jfetch(`${API}/api/v1/public/shops/${SLUG}/uploads/initiate`, { method: 'POST', json: { fileName: 'x.pdf', byteSize: 100, declaredMimeType: 'application/pdf' } });
  expect(init.status).toBe(409);

  // UI: closed notice, no upload control, tracking still works.
  const ctx = await newMobileContext(browser, VIEWPORTS.s360);
  const page = await ctx.newPage();
  await page.goto(`/p/${SLUG}`);
  await expect(page.getByRole('heading', { name: 'Closed for new orders' })).toBeVisible();
  await expect(page.getByTestId('file-input')).toHaveCount(0);
  await expectNoOverflow(page, 'closed 360');
  await snap(page, 'customer-closed-360');
  await scan(page, 'closed page', 'main');
  await page.goto(`/t/${existing.trackingToken}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Order');
  await ctx.close();

  // Policy ACCEPT: same closed shop takes the order and shows the non-blocking notice.
  setHours(week([]), 'ACCEPT');
  const ok = await jfetch(`${API}/api/v1/public/shops/${SLUG}/orders`, { method: 'POST', json: { quoteId: quote.body.data.quoteId, clientRequestId: crypto.randomUUID() } });
  expect(ok.status).toBe(200);
  const ctx2 = await newMobileContext(browser, VIEWPORTS.mobile);
  const p2 = await ctx2.newPage();
  await p2.goto(`/p/${SLUG}`);
  await expect(p2.getByText('Closed now')).toBeVisible();
  await expect(p2.getByTestId('file-input')).toHaveCount(1);
  await ctx2.close();
});

test('temporary closure and emergency reopen from the shop UI take effect for customers immediately', async ({ page, browser }) => {
  reset();
  setHours(week([{ start: '00:00', end: '24:00' }]), 'BLOCK');
  await uiLogin(page, OWNER);
  await page.goto('/shop/settings');
  const section = page.getByRole('region', { name: 'Operating hours' });
  await expect(section.getByRole('status', { name: 'Current shop status' })).toContainText('Open now');
  await section.getByLabel('Reason for closing (optional)').fill('Printer repair');
  await section.getByRole('button', { name: 'Close shop now' }).click();
  await expect(section.getByText('Temporary closure is on')).toBeVisible();

  const ctx = await newMobileContext(browser, VIEWPORTS.mobile);
  const cust = await ctx.newPage();
  await cust.goto(`/p/${SLUG}`);
  await expect(cust.getByText('Temporarily closed')).toBeVisible();
  await expect(cust.getByText('Printer repair')).toBeVisible();
  await expect(cust.getByTestId('file-input')).toHaveCount(0);

  await section.getByRole('button', { name: 'Reopen now' }).click();
  await expect(section.getByLabel('Reason for closing (optional)')).toBeVisible();
  await cust.reload();
  await expect(cust.getByText('Open now')).toBeVisible();
  await expect(cust.getByTestId('file-input')).toHaveCount(1);
  await ctx.close();
});

test("tenant isolation: Central's owner sees only Central's own hours, never Metro's", async ({ browser }) => {
  reset();
  // Central's UI session never sees Metro's settings: its GET /shop/hours returns Central's own (unconfigured) hours.
  setHours(week([]), 'BLOCK');
  const c = await (await newMobileContext(browser, VIEWPORTS.desktop)).newPage();
  await uiLogin(c, 'owner@central.test');
  await c.goto('/shop/settings');
  const section = c.getByRole('region', { name: 'Operating hours' });
  await expect(section.getByRole('status', { name: 'Current shop status' })).toContainText('Opening hours not set');
  await expect(section.getByRole('radio', { name: /Accept new orders/ })).toBeChecked();
  await c.context().close();
});

for (const [name, vp] of [['360', VIEWPORTS.s360], ['390', VIEWPORTS.mobile], ['768', VIEWPORTS.tablet], ['1440', VIEWPORTS.desktop]] as const) {
  test(`responsive ${name}px: hours editor and customer panel have no horizontal overflow`, async ({ browser }) => {
    reset();
    setHours({ ...week([{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }]), fri: [{ start: '21:00', end: '02:00' }] }, 'ACCEPT');
    const ctx = await newMobileContext(browser, vp);
    const page = await ctx.newPage();
    await uiLogin(page, OWNER);
    await page.goto('/shop/settings');
    await expect(page.getByRole('region', { name: 'Operating hours' }).getByLabel('Monday opens (1)')).toBeVisible();
    await expectNoOverflow(page, `hours editor ${name}`);
    await snap(page, `shop-editor-${name}`);
    await page.goto(`/p/${SLUG}`);
    await page.getByRole('region', { name: 'Opening hours' }).getByText('Weekly hours').click();
    await expectNoOverflow(page, `customer hours ${name}`);
    await snap(page, `customer-${name}`);
    await ctx.close();
  });
}
