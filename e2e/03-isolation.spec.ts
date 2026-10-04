import { expect, test } from '@playwright/test';
import { createOrderViaApi, expectNoOverflow, newMobileContext, shot, uiLogin } from './support';

test('tenant isolation in the browser: metro cannot see or open central orders, no SSE leak', async ({ browser }) => {
  const central = await newMobileContext(browser);
  const metro = await newMobileContext(browser);
  const c = await central.newPage();
  const m = await metro.newPage();

  await createOrderViaApi('central-print', { name: 'Central Prior Customer' });
  await uiLogin(c, 'owner@central.test');
  await expect(c.getByRole('heading', { name: 'Print queue' })).toBeVisible();
  const link = c.getByTestId('order-card').first().getByRole('link');
  await expect(link).toBeVisible();
  const centralHref = await link.getAttribute('href');
  expect(centralHref).toMatch(/^\/shop\/orders\/.+/);

  // metro: queue is empty, event stream is open
  const seen: string[] = [];
  await m.exposeFunction('__sse', (s: string) => seen.push(s));
  await uiLogin(m, 'owner@metro.test');
  await expect(m.getByRole('heading', { name: 'Print queue' })).toBeVisible();
  await expect(m.locator('.shop-conn')).toContainText('Live');
  await expect(m.getByText('No orders yet')).toBeVisible();
  await expect(m.getByTestId('order-card')).toHaveCount(0);
  await shot(m, '30-metro-empty-queue');
  await expectNoOverflow(m, 'metro queue');

  // direct URL to central's order
  await m.goto(centralHref!);
  await expect(m.getByText('Order not found')).toBeVisible();
  await expect(m.getByRole('button', { name: /Accept|Start|Confirm|Reprint/ })).toHaveCount(0);

  // central gets a new order; metro's SSE / queue must not react
  await m.goto('/shop');
  await expect(m.locator('.shop-conn')).toContainText('Live');
  const metroApiCalls: string[] = [];
  m.on('response', async (r) => { if (r.url().includes('/shop/orders?')) metroApiCalls.push(await r.text().catch(() => '')); });
  await createOrderViaApi('central-print', { name: 'Central Secret Customer', fileName: 'secret.pdf' });
  await expect(c.getByTestId('order-card').first()).toBeVisible();
  await c.getByRole('tab', { name: 'Active' }).click();
  await expect(c.getByText('Central Secret Customer')).toBeVisible({ timeout: 15_000 });
  await m.waitForTimeout(2500);
  await expect(m.getByText('Central Secret Customer')).toHaveCount(0);
  await expect(m.getByTestId('order-card')).toHaveCount(0);
  expect(metroApiCalls.join('')).not.toContain('secret.pdf');
  expect(await m.title()).toBe('Printout'); // no "(1)" new-order badge from another shop
  await central.close();
  await metro.close();
});
