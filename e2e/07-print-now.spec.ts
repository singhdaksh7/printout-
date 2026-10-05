import { expect, test } from '@playwright/test';
import { SLUG, VIEWPORTS, createOrderViaApi, expectNoOverflow, uiLogin } from './support';

test.use({ viewport: VIEWPORTS.desktop, acceptDownloads: true });

// Regression: the card's full-size "open order" link must never sit on top of the Print Now / Save file buttons
// (a real click, not a synthetic one, is what proves it).
test('queue card: one real click on Print Now moves NEW to PRINTING and opens the viewer; Save file is a separate explicit download', async ({ page }) => {
  await createOrderViaApi(SLUG, { name: 'PrintNow E2E', fileName: 'save-me.pdf' });
  await uiLogin(page, 'owner@central.test');
  const card = page.getByTestId('order-card').filter({ hasText: 'save-me.pdf' }).first();
  await expect(card).toBeVisible();
  await expectNoOverflow(page, 'queue with action buttons');

  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const popupP = page.context().waitForEvent('page');
  const printNow = card.getByRole('button', { name: 'Print Now' });
  await expect(printNow).toHaveClass(/sh-btn-primary/);
  await printNow.click(); // fails with "intercepts pointer events" if an overlay covers the button
  const popup = await popupP;
  await expect(card.getByRole('button', { name: 'Reopen document' })).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole('button', { name: /confirm/i })).toHaveCount(0); // opening never confirms printing
  await popup.close();
  expect(downloads).toEqual([]); // Print Now never downloads

  const dlP = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Save file' }).click();
  expect((await dlP).suggestedFilename()).toBe('save-me.pdf');

  // the details page keeps the explicit confirmation and the retention note
  await card.getByRole('link', { name: 'View details' }).click();
  await expect(page.getByRole('button', { name: 'Confirm printed successfully' })).toBeVisible();
  await expect(page.getByText(/managed by you/).first()).toBeVisible();
});
