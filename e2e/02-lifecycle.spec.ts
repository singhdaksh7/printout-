import { expect, test } from '@playwright/test';
import { API, RETENTION_MINUTES } from './env';
import { VIEWPORTS, createOrderViaApi, dbQuery, expectNoOverflow, newMobileContext, shot, uiLogin, writeState } from './support';

test('shop + customer lifecycle across two browser contexts (SSE, Print starts retention, 1-minute retention, deletion)', async ({ browser }) => {
  test.setTimeout(240_000);
  const shopCtx = await newMobileContext(browser);
  const custCtx = await newMobileContext(browser);
  const shop = await shopCtx.newPage();
  const cust = await custCtx.newPage();

  // ---- shop signs in; empty queue first ----
  await uiLogin(shop, 'owner@central.test');
  await expect(shop.getByRole('heading', { name: 'Print queue' })).toBeVisible();
  await expect(shop.locator('.shop-conn')).toContainText('Live');
  await expectNoOverflow(shop, 'shop queue');
  await shot(shop, '10-shop-queue');
  await shop.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1));

  // ---- a customer places an order; it appears with no refresh ----
  const NAME = 'Lifecycle Ravi';
  const order = await createOrderViaApi('central-print', { pages: 4, name: NAME, fileName: 'lifecycle-notes.pdf', colourMode: 'colour', sides: 'duplex', copies: 2 });
  writeState({ lifecycleToken: order.trackingToken });
  await cust.goto(`/t/${order.trackingToken}`);
  await expect(cust.getByText('Submitted').first()).toBeVisible();

  const card = shop.getByTestId('order-card').filter({ hasText: NAME });
  await expect(card).toBeVisible({ timeout: 15_000 });
  expect(await shop.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1); // same document: no reload
  await expect(card).toContainText(`#${order.orderNumber}`);
  await expect(card).toContainText('lifecycle-notes.pdf');
  await expect(card).toContainText('4 pages');
  await expect(card).toContainText('Colour');
  await expect(card).toContainText('Double-sided');
  await expect(card).toContainText('2 copies');
  await expect(card).toContainText('A4');
  await expect(card).toContainText('All pages');
  await expect(card).toContainText('₹36.00'); // 4 pages -> 2 sheets x 2 copies x Rs 9
  await expect(card.getByRole('button', { name: 'Print', exact: true })).toBeVisible();
  await expect(shop.locator('.shop-nav-badge')).toBeVisible();
  await shot(shop, '11-shop-queue-new-order');
  await expectNoOverflow(shop, 'queue with order');

  // ---- open the details page: merely viewing must NOT start the retention window ----
  await card.getByRole('link', { name: new RegExp(order.orderNumber) }).click();
  await expect(shop.getByRole('heading', { name: new RegExp(`Order #${order.orderNumber}`) })).toBeVisible();
  await shot(shop, '12-shop-order-new');
  await expectNoOverflow(shop, 'order detail NEW');
  const stamp = (sql: string) => dbQuery(`select ${sql} from "Document" d join "Order" o on o."documentId"=d.id where o."orderNumber"='${order.orderNumber}'`);
  expect(stamp(`d."printInitiatedAt" is null and d."deleteAfter" is null and d.status='AVAILABLE'`)).toBe('t');
  await shop.waitForTimeout(1500);
  expect(stamp(`d."printInitiatedAt" is null and d."deleteAfter" is null`)).toBe('t');

  // ---- Print: ONE click starts the window + opens the secure viewer. No Accept / Start / Confirm / Ready / Collected anywhere. ----
  for (const hidden of ['Accept only', 'Start printing', 'Confirm printed successfully', 'Mark ready', 'Mark collected']) {
    await expect(shop.getByRole('button', { name: hidden })).toHaveCount(0);
  }
  const popupP = shopCtx.waitForEvent('page');
  const docResP = shopCtx.waitForEvent('response', (r) => r.url().includes('/api/v1/internal/documents/'));
  await shop.getByRole('button', { name: 'Print', exact: true }).click();
  const popup = await popupP;
  await expect(shop.getByRole('button', { name: 'Reprint' })).toBeVisible();
  await expect(shop.getByTestId('countdown')).toBeVisible();
  expect(stamp(`extract(epoch from (d."deleteAfter" - d."printInitiatedAt"))::int`)).toBe(String(RETENTION_MINUTES * 60));
  expect(stamp(`d."printedAt" is null and d.status='PRINTED_RETENTION'`)).toBe('t'); // Print never claims a physical print
  await expect(cust.getByText('Your pages are being printed')).toBeVisible({ timeout: 30_000 }); // customer page polls/refreshes itself
  const docRes = await docResP; // headless Chromium has no PDF viewer, so the navigation itself may end as a download
  expect(docRes.status()).toBe(200);
  expect(docRes.headers()['content-type']).toBe('application/pdf');
  const href = await shop.getByRole('link', { name: 'Open document in a new tab' }).getAttribute('href');
  expect(href).toContain('/internal/documents/');
  const pdfRes = await shop.request.get(new URL(href!, API).toString());
  expect(pdfRes.status()).toBe(200);
  expect(pdfRes.headers()['content-type']).toBe('application/pdf');
  expect((await pdfRes.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await popup.close();
  const initiatedAt = stamp(`d."printInitiatedAt"`);
  await shot(shop, '14-shop-printed-countdown');
  await expectNoOverflow(shop, 'order detail after Print');
  await expect(cust.getByText(/Your file will be deleted in/)).toBeVisible({ timeout: 30_000 });
  await expect(cust.getByTestId('countdown')).toBeVisible();
  await shot(cust, '15-customer-countdown');
  await expectNoOverflow(cust, 'tracking countdown');

  // ---- reprint before expiry works and does not move the deadline ----
  const scheduledBefore = await shop.locator('dt:text-is("Scheduled deletion") + dd').textContent();
  const popup2P = shopCtx.waitForEvent('page');
  const doc2P = shopCtx.waitForEvent('response', (r) => r.url().includes('/api/v1/internal/documents/'));
  await shop.getByRole('button', { name: 'Reprint' }).click();
  const popup2 = await popup2P;
  expect((await doc2P).status()).toBe(200);
  await popup2.close();
  expect(await shop.locator('dt:text-is("Scheduled deletion") + dd').textContent()).toBe(scheduledBefore);
  expect(stamp(`d."printInitiatedAt"`)).toBe(initiatedAt); // Reprint never moves the start

  // ---- retention elapses (1 minute in this environment; worker runs every 3s) ----
  await expect(shop.getByText(/permanently removed/)).toBeVisible({ timeout: 120_000 });
  await expect(shop.getByRole('button', { name: 'Reprint' })).toHaveCount(0); // no Print / Reprint / Save once the file is gone
  await shot(shop, '16-shop-deleted');
  await expectNoOverflow(shop, 'order detail deleted');
  await expect(cust.getByText('Your file has been deleted')).toBeVisible({ timeout: 60_000 });
  await shot(cust, '17-customer-deleted');
  await expectNoOverflow(cust, 'tracking deleted');
  expect(VIEWPORTS.mobile.width).toBe(390);

  // queue "Recent" tab shows it with the deleted chip; it is no longer in New
  await shop.getByRole('link', { name: /Back to queue/ }).click();
  await expect(shop.getByTestId('order-card').filter({ hasText: NAME })).toHaveCount(0);
  await shop.getByRole('tab', { name: 'Recent' }).click();
  await expect(shop.getByTestId('order-card').filter({ hasText: NAME })).toContainText('File deleted automatically');
  expect(stamp(`d.status || ':' || (d."deletedAt" is not null)`)).toBe('DELETED:true');
  await shopCtx.close();
  await custCtx.close();
});
