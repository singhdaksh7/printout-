import { expect, test } from '@playwright/test';
import { SLUG, VIEWPORTS, createOrderViaApi, expectNoOverflow, makePdf, shot, uiLogin } from './support';

test.use({ viewport: VIEWPORTS.desktop });

test('desktop 1440: customer page smoke', async ({ page }) => {
  await page.goto(`/p/${SLUG}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Central Print' })).toBeVisible();
  await page.getByTestId('file-input').setInputFiles({ name: 'd.pdf', mimeType: 'application/pdf', buffer: await makePdf(5) });
  await expect(page.getByTestId('total')).toHaveText('₹10.00');
  await expectNoOverflow(page, 'desktop customer');
  await shot(page, '40-desktop-customer');
});

test('desktop 1440: shop queue, pricing persistence, QR poster, analytics, settings', async ({ page }) => {
  await createOrderViaApi(SLUG, { name: 'Desktop Dev', fileName: 'desk.pdf' });
  // pricing is edited on the OTHER demo shop so central quotes stay stable for the other specs
  await uiLogin(page, 'owner@metro.test');
  await expect(page.getByRole('heading', { name: 'Print queue' })).toBeVisible();
  await expectNoOverflow(page, 'desktop queue');

  await page.getByRole('link', { name: 'Pricing' }).click();
  await expect(page.getByRole('heading', { name: 'Pricing' })).toBeVisible();
  const input = page.locator('#price-bw-single');
  await expect(input).toHaveValue(/^2(\.00)?$/);
  await input.fill('3.50');
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByRole('button', { name: 'Save prices' })).toBeDisabled();
  await shot(page, '41-desktop-pricing');
  await page.reload();
  await expect(page.locator('#price-bw-single')).toHaveValue(/^3\.5(0)?$/);
  // server really uses it: customer quote for metro
  const quoted = await (async () => {
    const p2 = await page.context().newPage();
    await p2.goto('/p/metro-copies');
    await p2.getByTestId('file-input').setInputFiles({ name: 'm.pdf', mimeType: 'application/pdf', buffer: await makePdf(2) });
    await expect(p2.getByTestId('total')).toHaveText('₹7.00');
    await p2.close();
    return true;
  })();
  expect(quoted).toBe(true);

  await page.getByRole('link', { name: 'QR' }).click();
  await expect(page.getByTestId('qr-poster')).toBeAttached();
  await expect(page.getByRole('img', { name: /QR code for/ })).toBeVisible();
  await shot(page, '42-desktop-qr');
  await page.emulateMedia({ media: 'print' });
  await shot(page, '43-desktop-qr-print-media');
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;
  expect(pages, 'poster must print on exactly one A4 page').toBe(1);
  await expect(page.locator('.shop-nav')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });

  await page.getByRole('link', { name: 'Analytics' }).click();
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await expect(page.locator('main')).toContainText('Estimated order value');
  expect(await page.locator('main').innerText()).not.toMatch(/revenue/i);
  await shot(page, '44-desktop-analytics');
  await expectNoOverflow(page, 'analytics');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await shot(page, '45-desktop-settings');
  await expectNoOverflow(page, 'settings');
});

test('desktop 1440: admin dashboard, shops, shop detail', async ({ page }) => {
  await uiLogin(page, 'admin@printout.test', '/admin/login');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.locator('main')).toContainText(/shops/i);
  await shot(page, '46-admin-dashboard');
  await expectNoOverflow(page, 'admin dashboard');
  await page.getByRole('link', { name: /^Shops$/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();
  await expect(page.getByText('/central-print')).toBeVisible();
  await expect(page.getByText('/metro-copies')).toBeVisible();
  await shot(page, '47-admin-shops');
  await page.getByRole('link', { name: 'Central Print' }).click();
  await expect(page.getByRole('heading', { name: 'Central Print' })).toBeVisible();
  await expect(page.getByText('Usage')).toBeVisible();
  await shot(page, '48-admin-shop-detail');
  await expectNoOverflow(page, 'admin shop detail');
  // admin must never see documents
  expect(await page.locator('body').innerText()).not.toMatch(/internal\/documents|objectKey/);
});
