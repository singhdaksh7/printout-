import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ART, SLUG, VIEWPORTS, createOrderViaApi, expectNoOverflow, newMobileContext, uiLogin } from './support';

// Shopkeeper UI migration, stage 1 (print queue + order detail): accessibility scans of the migrated region (axe, WCAG 2.1 A/AA)
// and screenshots of every state, at desktop and phone width, for comparison with docs/design/3.pdf (p7-p14, p23-p24).
// Runs against the isolated e2e database like the other specs.

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).include('#shop-main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe violations on ${label}\n${summary.join('\n')}`).toEqual([]);
}
const snap = (page: Page, name: string, fullPage = true) => page.screenshot({ path: path.join(ART, `s1-${name}.png`), fullPage });

async function walk(page: Page, vp: 'desktop' | 'mobile', fileA: string, fileB: string) {
  await uiLogin(page, 'owner@central.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Print queue' })).toBeVisible();
  const rowA = page.getByTestId('order-card').filter({ hasText: fileA }).first();
  await expect(rowA).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectNoOverflow(page, `queue ${vp}`);
  await scan(page, `queue ${vp}`);
  await snap(page, `queue-${vp}`);

  // order detail (nobody printed yet): Print + Save file + Cancel order
  await page.getByTestId('order-card').filter({ hasText: fileB }).first().getByRole('link').first().click();
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible();
  await expectNoOverflow(page, `detail ${vp}`);
  await scan(page, `detail new ${vp}`);
  await snap(page, `detail-new-${vp}`);

  // cancel confirmation modal
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(350);
  await scan(page, `cancel modal ${vp}`);
  await snap(page, `cancel-modal-${vp}`, false);
  await page.getByRole('button', { name: 'Keep order' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Print from the queue row/card: moves to Recent with Reprint + retention
  await page.getByRole('link', { name: /Back to queue/ }).click();
  const row = page.getByTestId('order-card').filter({ hasText: fileA }).first();
  const popupP = page.context().waitForEvent('page');
  await row.getByRole('button', { name: 'Print', exact: true }).click();
  await (await popupP).close();
  await expect(page.getByTestId('order-card').filter({ hasText: fileA })).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('tab', { name: 'Recent' }).click();
  const recent = page.getByTestId('order-card').filter({ hasText: fileA }).first();
  await expect(recent.getByRole('button', { name: 'Reprint' })).toBeVisible();
  await expect(recent.getByTestId('reprint-window')).toContainText('Available for reprint for');
  await scan(page, `queue recent ${vp}`);
  await snap(page, `queue-recent-${vp}`);

  // detail after Print: retention countdown panel
  await recent.getByRole('link', { name: 'View' }).click();
  await expect(page.getByTestId('countdown')).toBeVisible();
  await scan(page, `detail printed ${vp}`);
  await snap(page, `detail-printed-${vp}`);

  // cancel B for real and see it under Cancelled / expired
  await page.getByRole('link', { name: /Back to queue/ }).click();
  await page.getByTestId('order-card').filter({ hasText: fileB }).first().getByRole('link').first().click();
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('This order is cancelled. No further actions.')).toBeVisible();
  await page.waitForTimeout(400); // let the toast's 150 ms entrance animation finish: axe would otherwise measure its mid-fade colours
  await scan(page, `detail cancelled ${vp}`);
  await snap(page, `detail-cancelled-${vp}`);
  await page.getByRole('link', { name: /Back to queue/ }).click();
  await page.getByRole('tab', { name: 'Cancelled / expired' }).click();
  await expect(page.getByTestId('order-card').filter({ hasText: fileB }).first()).toBeVisible();
  await scan(page, `queue cancelled ${vp}`);
  await snap(page, `queue-cancelled-${vp}`);

  // empty state and error banner (API answers are stubbed ONLY for these two captures)
  await page.route('**/api/v1/shop/orders?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { items: [] } }) }));
  await page.getByRole('tab', { name: 'New' }).click();
  await expect(page.getByText('No new requests')).toBeVisible();
  await scan(page, `queue empty ${vp}`);
  await snap(page, `queue-empty-${vp}`, false);
  await page.unroute('**/api/v1/shop/orders?**');
  await page.route('**/api/v1/shop/orders?**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x', requestId: 'r' } }) }));
  await page.getByRole('tab', { name: 'Recent' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await scan(page, `queue error ${vp}`);
  await snap(page, `queue-error-${vp}`, false);
  await page.unroute('**/api/v1/shop/orders?**');
}

test('stage 1 desktop: queue and order detail are accessible and match the design states', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await createOrderViaApi(SLUG, { name: 'S1 Alpha', fileName: 's1-alpha-desktop.pdf', pages: 5 });
  await createOrderViaApi(SLUG, { name: 'S1 Beta', fileName: 's1-beta-desktop.pdf', pages: 3, colourMode: 'colour', sides: 'duplex', copies: 2 });
  await walk(page, 'desktop', 's1-alpha-desktop.pdf', 's1-beta-desktop.pdf');
});

test('stage 1 mobile 390: queue cards and order detail are accessible and match the design states', async ({ browser }) => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await createOrderViaApi(SLUG, { name: 'S1 Gamma', fileName: 's1-gamma-mobile.pdf', pages: 4 });
  await createOrderViaApi(SLUG, { name: 'S1 Delta', fileName: 's1-delta-mobile.pdf', pages: 2, colourMode: 'colour', copies: 3 });
  await walk(page, 'mobile', 's1-gamma-mobile.pdf', 's1-delta-mobile.pdf');
  await ctx.close();
});
