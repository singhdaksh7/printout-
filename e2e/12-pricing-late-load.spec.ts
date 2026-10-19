import { expect, test } from '@playwright/test';
import { VIEWPORTS, uiLogin } from './support';

// Regression: the Rate card page loads its rules in an effect, and React StrictMode (dev) runs effects twice, so two GETs are in
// flight. A slow earlier/later response used to reset the form to the saved prices AFTER the shopkeeper had started typing, leaving
// "Save prices" disabled (seen once in a full run, 04-desktop). Only the latest load may touch the form.
test.use({ viewport: VIEWPORTS.desktop });

test('rate card: a slow load response never overwrites what the shopkeeper typed', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/shop/pricing-rules', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    calls++;
    // every response after the first one is slow: the first one paints the form, the later one lands while the user is typing
    if (calls > 1) await new Promise((r) => setTimeout(r, 2500));
    return route.continue();
  });
  await uiLogin(page, 'owner@metro.test');
  await page.getByRole('link', { name: 'Rate card' }).click();
  const input = page.getByRole('textbox', { name: 'B&W · Single-sided' });
  await expect(input).toBeVisible();
  await input.fill('7.25');
  await page.waitForTimeout(3500); // let the slow response arrive
  expect(calls).toBeGreaterThan(1);
  await expect(input).toHaveValue('7.25');
  await expect(page.getByRole('button', { name: 'Save prices' })).toBeEnabled();
});
