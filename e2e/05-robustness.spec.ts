import { expect, test } from '@playwright/test';
import { PREVIEW } from './env';
import { SLUG, VIEWPORTS, createOrderViaApi, expectNoOverflow, newMobileContext, shot, uiLogin } from './support';

test('empty queue shows guidance (metro, no orders)', async ({ browser }) => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await uiLogin(page, 'owner@metro.test');
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open counter QR' })).toBeVisible();
  await expectNoOverflow(page, 'empty queue');
  await shot(page, '50-empty-queue');
  await ctx.close();
});

test('large queue: 60 orders paginate with Load more, no overflow', async ({ browser }) => {
  test.setTimeout(240_000);
  for (let i = 0; i < 60; i++) await createOrderViaApi(SLUG, { name: `Bulk ${i}`, fileName: `bulk-${i}-${'x'.repeat(60)}.pdf`, pages: 2 });
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await uiLogin(page, 'owner@central.test');
  await expect(page.getByTestId('order-card').first()).toBeVisible();
  expect(await page.getByTestId('order-card').count()).toBe(50);
  await expectNoOverflow(page, 'large queue');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect.poll(() => page.getByTestId('order-card').count()).toBeGreaterThanOrEqual(60);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expectNoOverflow(page, 'large queue loaded');
  await shot(page, '51-large-queue', false);
  await ctx.close();
});

test('SSE reconnect, network error banner with retry, session expiry redirect', async ({ browser }) => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await uiLogin(page, 'owner@metro.test');
  await expect(page.locator('.shop-conn')).toContainText('Live');

  // --- SSE drop and recovery: block the stream, reload (stream cannot connect), then restore
  await page.route('**/api/v1/shop/events', (r) => r.abort());
  await page.reload();
  await expect(page.locator('.shop-conn')).not.toContainText('Live', { timeout: 15_000 });
  await shot(page, '52-sse-down');
  await page.unroute('**/api/v1/shop/events');
  await expect(page.locator('.shop-conn')).toContainText('Live', { timeout: 45_000 });

  // --- network error banner on the queue
  await page.route('**/api/v1/shop/orders?**', (r) => r.abort());
  await page.getByRole('tab', { name: 'Ready' }).click();
  await expect(page.getByRole('button', { name: /retry|try again/i }).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, '53-network-error');
  await expectNoOverflow(page, 'network error');
  await page.unroute('**/api/v1/shop/orders?**');
  await page.getByRole('button', { name: /retry|try again/i }).first().click();
  await expect(page.getByRole('heading', { name: /No orders|Nothing finished/ })).toBeVisible();

  // --- session expiry: cookies vanish, next protected call sends us to login
  await ctx.clearCookies();
  await page.getByRole('link', { name: 'Pricing' }).click();
  await expect(page).toHaveURL(/\/shop\/login/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Shop sign in' })).toBeVisible();
  await shot(page, '54-session-expired');
  await ctx.close();
});

test('customer: upload network failure shows a friendly error, no overflow', async ({ browser }) => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await page.goto(`/p/${SLUG}`);
  await page.route('**/uploads/initiate', (r) => r.abort());
  await page.getByTestId('file-input').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText(/TypeError|Failed to fetch/);
  await expectNoOverflow(page, 'upload network failure');
  await ctx.close();
});

test('PWA: manifest, icons, meta tags and service worker (built app via vite preview)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: VIEWPORTS.mobile });
  const page = await ctx.newPage();
  await page.goto(`${PREVIEW}/p/${SLUG}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Central Print' })).toBeVisible();
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await page.request.get(new URL(href!, PREVIEW).toString());
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest.name).toBe('Printout');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  for (const icon of manifest.icons) {
    const r = await page.request.get(new URL(icon.src, PREVIEW + '/').toString());
    expect(r.status(), `icon ${icon.src}`).toBe(200);
    expect(r.headers()['content-type']).toMatch(/image\//);
  }
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toMatch(/^#/);
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover');
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 15000))]);
    return reg ? 'registered' : 'timeout';
  });
  expect(sw).toBe('registered');
  const status = await page.evaluate(async () => (await fetch('/api/v1/public/shops/central-print')).status);
  expect(status).toBe(200);
  await ctx.close();
});

void createOrderViaApi;
