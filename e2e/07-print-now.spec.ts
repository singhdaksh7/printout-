import { expect, test } from '@playwright/test';
import { SLUG, VIEWPORTS, createOrderViaApi, dbQuery, expectNoOverflow, newMobileContext, uiLogin } from './support';

test.use({ viewport: VIEWPORTS.desktop, acceptDownloads: true });

const stamps = (file: string) =>
  dbQuery(`select coalesce(d."printInitiatedAt"::text,'-') || '|' || coalesce(d."deleteAfter"::text,'-') from "Document" d where d."originalFilename"='${file}' order by d."createdAt" desc limit 1`);

// Regression: the card's full-size "open order" link must never sit on top of the Print / Save file buttons
// (a real click, not a synthetic one, is what proves it).
test('desktop queue: one real click on Print starts retention, moves the card to Recent with Reprint; Save file never changes the deadline', async ({ page }) => {
  await createOrderViaApi(SLUG, { name: 'Print E2E', fileName: 'save-me.pdf' });
  await uiLogin(page, 'owner@central.test');
  const card = page.getByTestId('order-card').filter({ hasText: 'save-me.pdf' }).first();
  await expect(card).toBeVisible();
  await expectNoOverflow(page, 'queue with action buttons');
  expect(stamps('save-me.pdf')).toBe('-|-'); // upload alone starts nothing

  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const popupP = page.context().waitForEvent('page');
  const print = card.getByRole('button', { name: 'Print', exact: true });
  await expect(print).toHaveClass(/sh-btn-primary/);
  await print.click(); // fails with "intercepts pointer events" if an overlay covers the button
  const popup = await popupP;
  await popup.close();
  expect(downloads).toEqual([]); // Print never downloads
  await expect(page.getByTestId('order-card').filter({ hasText: 'save-me.pdf' })).toHaveCount(0, { timeout: 15_000 }); // left the New queue
  const started = stamps('save-me.pdf');
  expect(started).not.toContain('-|');

  await page.getByRole('tab', { name: 'Recent' }).click();
  const recent = page.getByTestId('order-card').filter({ hasText: 'save-me.pdf' }).first();
  await expect(recent.getByRole('button', { name: 'Reprint' })).toHaveClass(/sh-btn-primary/);
  await expect(recent.getByTestId('reprint-window')).toContainText('Available for reprint for');
  await expect(recent.getByRole('button', { name: /confirm|accept|ready|collected/i })).toHaveCount(0);

  const dlP = page.waitForEvent('download');
  await recent.getByRole('button', { name: 'Save file' }).click();
  expect((await dlP).suggestedFilename()).toBe('save-me.pdf');
  expect(stamps('save-me.pdf')).toBe(started); // Save File never changes the deadline

  const popup2P = page.context().waitForEvent('page');
  await recent.getByRole('button', { name: 'Reprint' }).click();
  await (await popup2P).close();
  expect(stamps('save-me.pdf')).toBe(started); // Reprint never changes the deadline

  await recent.getByRole('link', { name: 'View' }).click();
  await expect(page.getByRole('button', { name: 'Reprint' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Confirm printed|Mark ready|Mark collected|Accept/ })).toHaveCount(0);
  await expect(page.getByText(/managed by you/).first()).toBeVisible();
  expect(stamps('save-me.pdf')).toBe(started);
});

test('mobile queue: a real tap on Print works and the card moves to Recent', async ({ browser }) => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await createOrderViaApi(SLUG, { name: 'Print Mobile', fileName: 'mobile-tap.pdf' });
  await uiLogin(page, 'owner@central.test');
  const card = page.getByTestId('order-card').filter({ hasText: 'mobile-tap.pdf' }).first();
  await expect(card).toBeVisible();
  await expectNoOverflow(page, 'mobile queue card');
  for (const spec of ['Print Mobile', 'mobile-tap.pdf', 'pages', 'B&W', '1 copy', 'Single-sided', 'All pages', 'A4']) await expect(card).toContainText(spec);
  const popupP = ctx.waitForEvent('page');
  await card.getByRole('button', { name: 'Print', exact: true }).tap();
  await (await popupP).close();
  await expect(page.getByTestId('order-card').filter({ hasText: 'mobile-tap.pdf' })).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('tab', { name: 'Recent' }).click();
  await expect(page.getByTestId('order-card').filter({ hasText: 'mobile-tap.pdf' }).getByRole('button', { name: 'Reprint' })).toBeVisible();
  await expectNoOverflow(page, 'mobile recent');
  await ctx.close();
});
