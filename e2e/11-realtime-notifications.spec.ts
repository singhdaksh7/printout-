import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ART, VIEWPORTS, createOrderViaApi, dbQuery, expectNoOverflow, uiLogin } from './support';
import path from 'node:path';

// Real-time order notifications against the real API + disposable database:
// two isolated shops, live toast/bell with no refresh, durable unread state, offline catch-up, opt-in sound, accessibility.

test.describe.configure({ mode: 'serial' });
test.use({ viewport: VIEWPORTS.desktop });

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(ART, `notifications-${name}.png`), fullPage: false });

/** Counts oscillators started by the page so sound behaviour is observable without hearing it. */
const COUNT_AUDIO = () => {
  const w = window as unknown as { __beeps: number; AudioContext: typeof AudioContext };
  w.__beeps = 0;
  const proto = w.AudioContext.prototype;
  const orig = proto.createOscillator;
  proto.createOscillator = function (this: AudioContext) {
    const osc = orig.call(this);
    const start = osc.start.bind(osc);
    osc.start = (when?: number) => { w.__beeps += 1; start(when); };
    return osc;
  };
};
const beeps = (page: Page) => page.evaluate(() => (window as unknown as { __beeps: number }).__beeps);

let a: BrowserContext;
let b: BrowserContext;
let pa: Page;
let pb: Page;

const unreadBell = (p: Page, n: number) => p.getByRole('button', { name: `Notifications, ${n} unread` });
const toast = (p: Page, orderNumber: string) => p.locator('.pb-toast', { hasText: `New order ${orderNumber}` });
const orderIdOf = (orderNumber: string) => dbQuery(`select id from "Order" where "orderNumber" = '${orderNumber}'`);

test.beforeAll(async ({ browser }) => {
  a = await browser.newContext({ viewport: VIEWPORTS.desktop });
  b = await browser.newContext({ viewport: VIEWPORTS.desktop });
  await a.addInitScript(COUNT_AUDIO);
  pa = await a.newPage();
  pb = await b.newPage();
  await uiLogin(pa, 'owner@central.test');
  await uiLogin(pb, 'owner@metro.test');
  for (const p of [pa, pb]) {
    await expect(p.getByRole('heading', { name: 'Print queue' })).toBeVisible();
    await expect(p.locator('.shop-conn')).toContainText('Live');
  }
});
test.afterAll(async () => { await a?.close(); await b?.close(); });

test('a new order in shop A notifies shop A instantly without a refresh, and shop B receives nothing', async () => {
  await expect(pa.getByRole('button', { name: 'Notifications' })).toBeVisible();
  const order = await createOrderViaApi('central-print', { name: 'Asha', fileName: 'private-thesis.pdf' });
  await expect(toast(pa, order.orderNumber)).toBeVisible({ timeout: 10_000 });
  await expect(unreadBell(pa, 1)).toBeVisible();
  await expect(pa.getByTestId('order-card').first()).toBeVisible(); // queue refreshed by itself
  await shot(pa, 'desktop-toast');

  // Shop B: no toast, no badge, empty durable inbox, and the API never lists A's notification for B.
  await pb.waitForTimeout(2500);
  await expect(pb.locator('.pb-toast')).toHaveCount(0);
  await expect(pb.getByRole('button', { name: 'Notifications' })).toBeVisible();
  const forB = await b.request.get('/api/v1/shop/notifications');
  expect(forB.status()).toBe(200);
  const bodyB = JSON.stringify(await forB.json());
  expect((JSON.parse(bodyB) as { data: { items: unknown[] } }).data.items).toHaveLength(0);
  expect(bodyB).not.toContain(order.orderNumber);

  // No document data in what A is sent.
  const forA = await (await a.request.get('/api/v1/shop/notifications')).text();
  for (const secret of ['private-thesis', 'objectKey', order.trackingToken, 'Asha']) expect(forA).not.toContain(secret);
});

test('the notification links to the correct order', async () => {
  const order = await createOrderViaApi('central-print', { fileName: 'second.pdf' });
  await expect(toast(pa, order.orderNumber)).toBeVisible({ timeout: 10_000 });
  await unreadBell(pa, 2).click();
  const dialog = pa.getByRole('dialog', { name: 'Notifications' });
  await expect(dialog).toBeVisible();
  const first = dialog.getByRole('list', { name: /newest first/i }).getByRole('link').first();
  await expect(first).toContainText(order.orderNumber);
  await shot(pa, 'desktop-panel');
  await first.click();
  await expect(pa).toHaveURL(new RegExp(`/shop/orders/${orderIdOf(order.orderNumber)}$`));
  await expect(pa.getByRole('dialog')).toHaveCount(0);
  await expect(unreadBell(pa, 1)).toBeVisible(); // opening it marked that one read
});

test('unread state survives a refresh; mark as read and mark all as read are durable', async () => {
  await pa.goto('/shop');
  await expect(unreadBell(pa, 1)).toBeVisible();
  await createOrderViaApi('central-print');
  await expect(unreadBell(pa, 2)).toBeVisible({ timeout: 10_000 });
  await pa.reload();
  await expect(unreadBell(pa, 2)).toBeVisible();
  await unreadBell(pa, 2).click();
  await pa.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(pa.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  await pa.keyboard.press('Escape');
  await pa.reload();
  await expect(pa.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  expect(dbQuery(`select count(*) from "ShopNotification" where "readAt" is null and "shopId" = (select id from "Shop" where slug = 'central-print')`)).toBe('0');
});

test('a browser that was offline catches up on the orders it missed, once, and does not ring', async () => {
  // A real gap: the event stream is refused (like a network/proxy outage) while the page is loaded, orders arrive, then it returns.
  await pa.route('**/api/v1/shop/events*', (route) => route.abort());
  await pa.goto('/shop');
  await expect(pa.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(pa.locator('.shop-conn')).toContainText(/Reconnecting|Connecting|Offline/);
  await pa.evaluate(() => { (window as unknown as { __beeps: number }).__beeps = 0; });
  const m1 = await createOrderViaApi('central-print');
  const m2 = await createOrderViaApi('central-print');
  await pa.waitForTimeout(500);
  await expect(unreadBell(pa, 2)).toHaveCount(0); // nothing leaked in while disconnected
  await pa.unroute('**/api/v1/shop/events*');
  await pa.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(unreadBell(pa, 2)).toBeVisible({ timeout: 20_000 });
  await expect(pa.getByTestId('notif-announce')).toContainText('2 new orders arrived while you were away');
  await unreadBell(pa, 2).click();
  const list = pa.getByRole('dialog').getByRole('list', { name: /newest first/i });
  await expect(list.getByRole('listitem').filter({ hasText: m1.orderNumber })).toHaveCount(1);
  await expect(list.getByRole('listitem').filter({ hasText: m2.orderNumber })).toHaveCount(1);
  expect(await beeps(pa)).toBe(0);
  await pa.keyboard.press('Escape');
});

test('sound is off until the shopkeeper opts in, then rings once per live order but never on refresh', async () => {
  await pa.goto('/shop');
  await expect(pa.locator('.shop-conn')).toContainText('Live');
  expect(await pa.evaluate(() => window.localStorage.getItem('printout.shop.sound'))).toBeNull();
  const off = await createOrderViaApi('central-print');
  await expect(toast(pa, off.orderNumber)).toBeVisible({ timeout: 10_000 });
  expect(await beeps(pa)).toBe(0);

  await pa.getByRole('button', { name: /^Notifications/ }).click();
  const box = pa.getByRole('dialog').getByRole('checkbox', { name: 'Sound for new orders' });
  await expect(box).not.toBeChecked();
  await box.check(); // explicit opt-in (a user gesture, so the browser allows audio)
  expect(await pa.evaluate(() => window.localStorage.getItem('printout.shop.sound'))).toBe('1');
  await pa.keyboard.press('Escape');
  await pa.waitForTimeout(3300);
  const on = await createOrderViaApi('central-print');
  await expect(toast(pa, on.orderNumber)).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => beeps(pa)).toBe(2); // one two-tone chime

  const before = await beeps(pa);
  await pa.reload();
  await expect(pa.locator('.shop-conn')).toContainText('Live');
  await pa.waitForTimeout(1500);
  expect(await beeps(pa)).toBe(0); // fresh page: nothing replays
  expect(before).toBe(2);

  // mute persists
  await pa.getByRole('button', { name: /^Notifications/ }).click();
  await pa.getByRole('dialog').getByRole('checkbox', { name: 'Sound for new orders' }).uncheck();
  expect(await pa.evaluate(() => window.localStorage.getItem('printout.shop.sound'))).toBe('0');
  await pa.keyboard.press('Escape');
});

test('two tabs of the same shop raise exactly one toast per order', async () => {
  const second = await a.newPage();
  await second.goto('/shop');
  await expect(second.locator('.shop-conn')).toContainText('Live');
  await pa.bringToFront();
  const order = await createOrderViaApi('central-print');
  const total = async () => (await toast(pa, order.orderNumber).count()) + (await toast(second, order.orderNumber).count());
  await expect.poll(total, { timeout: 10_000 }).toBeGreaterThan(0);
  await pa.waitForTimeout(1500);
  expect(await total()).toBe(1);
  // both tabs still show the same durable unread count
  const n = Number(dbQuery(`select count(*) from "ShopNotification" where "readAt" is null and "shopId" = (select id from "Shop" where slug = 'central-print')`));
  await expect(second.getByRole('button', { name: `Notifications, ${n} unread` })).toBeVisible();
  await second.close();
});

test('accessibility and layout: desktop panel passes axe; phone layouts do not overflow', async ({ browser }) => {
  await pa.goto('/shop');
  await pa.getByRole('button', { name: /^Notifications/ }).click();
  await expect(pa.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  const desktop = await new AxeBuilder({ page: pa }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(desktop.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`), 'axe (desktop, panel open)').toEqual([]);
  await pa.keyboard.press('Escape');
  await expect(pa.getByRole('button', { name: /^Notifications/ })).toBeFocused();

  for (const [label, vp] of [['360', VIEWPORTS.s360], ['390', VIEWPORTS.mobile], ['430', VIEWPORTS.s430]] as const) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await uiLogin(p, 'owner@central.test');
    await expect(p.getByRole('heading', { name: 'Print queue' })).toBeVisible();
    await expect(p.getByRole('button', { name: /^Notifications/ })).toBeVisible();
    await expectNoOverflow(p, `shop topbar with bell ${label}`);
    await shot(p, `mobile-${label}-topbar`);
    await p.getByRole('button', { name: /^Notifications/ }).click();
    await expect(p.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await expectNoOverflow(p, `notification panel ${label}`);
    const box = await p.getByRole('dialog').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(vp.width);
    if (label === '390') {
      const phone = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(phone.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`), 'axe (phone, panel open)').toEqual([]);
      await shot(p, 'mobile-390-panel');
    }
    await ctx.close();
  }
});

test('existing queue and Order History keep working with notifications present', async () => {
  await pa.goto('/shop');
  await expect(pa.getByTestId('queue-stats')).toBeVisible();
  await expect(pa.getByTestId('order-card').first()).toBeVisible();
  await pa.getByRole('link', { name: 'History', exact: true }).first().click();
  await expect(pa.getByRole('heading', { level: 1, name: /History/ })).toBeVisible();
  await pa.getByRole('link', { name: 'Print queue' }).first().click();
  await expect(pa.getByRole('heading', { name: 'Print queue' })).toBeVisible();
  await pb.goto('/shop');
  await expect(pb.getByRole('heading', { name: 'Print queue' })).toBeVisible();
  await expect(pb.getByTestId('order-card')).toHaveCount(0);
});
