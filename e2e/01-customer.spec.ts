import { expect, test, type Page } from '@playwright/test';
import { MAX_BYTES } from './env';
import { SLUG, VIEWPORTS, expectNoOverflow, makeEncryptedPdf, makeExe, makeJpeg, makePdf, makePng, newMobileContext, shot, writeState } from './support';

test.describe.configure({ mode: 'serial' });

async function pick(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType, buffer });
}

test('mobile customer: PDF upload, server page count, options, quote, single submit, tracking', async ({ browser }) => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await page.goto(`/p/${SLUG}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Central Print' })).toBeVisible();
  await expectNoOverflow(page, 'shop landing');
  await shot(page, '01-customer-landing');

  // meta / PWA basics
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('width=device-width');
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBeTruthy();

  await pick(page, 'report.pdf', 'application/pdf', await makePdf(3));
  await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/pages\s*·\s*ready/)).toBeVisible();
  await expect(page.getByTestId('total')).toBeVisible(); // initial quote (all pages, bw, single, 3 sheets x Rs 2)
  await expect(page.getByTestId('total')).toHaveText('₹6.00');
  await expectNoOverflow(page, 'configure');

  await page.getByRole('radio', { name: 'Colour', exact: true }).click();
  await page.getByRole('radio', { name: 'Double-sided' }).click();
  await page.getByRole('radio', { name: 'Custom' }).click();
  await page.getByPlaceholder(/e\.g\./).fill('1-2');
  // colour duplex 1000? seed: colour/duplex 900 paise, 2 pages -> 1 sheet -> Rs 9.00
  await expect(page.getByTestId('total')).toHaveText('₹9.00');
  await expect(page.getByText('Pages selected').locator('xpath=following-sibling::dd')).toHaveText('2');
  await expect(page.getByText('Sheets per copy').locator('xpath=following-sibling::dd')).toHaveText('1');
  await page.getByRole('button', { name: 'Increase copies' }).click();
  await expect(page.getByTestId('total')).toHaveText('₹18.00');
  await expectNoOverflow(page, 'configured');
  await shot(page, '02-customer-configured');

  // malformed range -> inline error, no price, submit disabled
  await page.getByPlaceholder(/e\.g\./).fill('5-1');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Place order' })).toBeDisabled();
  await page.getByPlaceholder(/e\.g\./).fill('1-9'); // out of range for a 3-page doc
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Place order' })).toBeDisabled();
  await page.getByPlaceholder(/e\.g\./).fill('abc');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.getByPlaceholder(/e\.g\./).fill('1-2');
  await expect(page.getByTestId('total')).toHaveText('₹18.00');

  await page.getByLabel(/Name or reference/).fill('Asha E2E');

  // double click guard: exactly one order is created
  let orderPosts = 0;
  await page.route('**/public/shops/*/orders', (route) => {
    if (route.request().method() === 'POST') orderPosts += 1;
    return route.continue();
  });
  const place = page.getByRole('button', { name: 'Place order' });
  await place.dblclick();
  await expect(page).toHaveURL(/\/t\/.+/);
  expect(orderPosts).toBe(1);
  const token = decodeURIComponent(page.url().split('/t/')[1]!);
  writeState({ customerToken: token });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Order');
  await expect(page.getByText('Submitted').first()).toBeVisible();
  await expect(page.getByText('₹18.00').first()).toBeVisible();
  await expectNoOverflow(page, 'tracking');
  await shot(page, '03-customer-tracking-new');

  // refresh persistence
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Order');
  await expect(page.getByText('₹18.00').first()).toBeVisible();
  // bad token
  await page.goto('/t/not-a-real-token');
  await expect(page.getByText('Order not found')).toBeVisible();
  await expectNoOverflow(page, 'tracking 404');
  await ctx.close();
});

test('mobile customer: JPG and PNG are one printable page each', async ({ browser }) => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await page.goto(`/p/${SLUG}`);
  await pick(page, 'photo.jpg', 'image/jpeg', makeJpeg());
  await expect(page.getByText(/1\s*page\s*·\s*ready/)).toBeVisible();
  await expect(page.getByTestId('total')).toHaveText('₹2.00');
  await page.getByRole('button', { name: 'Replace file' }).click();
  await pick(page, 'scan.png', 'image/png', makePng());
  await expect(page.getByText(/1\s*page\s*·\s*ready/)).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Custom' })).toHaveCount(0); // single-page doc: no custom range
  await expectNoOverflow(page, 'image upload');
  await ctx.close();
});

test('mobile customer: invalid, encrypted, oversized and long-named files are handled', async ({ browser }) => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  await page.goto(`/p/${SLUG}`);

  await pick(page, 'invoice.pdf', 'application/pdf', makeExe());
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText(/stack|ECONN|undefined/i);
  await expect(page.getByRole('button', { name: 'Choose a different file' })).toBeVisible();
  await expectNoOverflow(page, 'invalid file');
  await shot(page, '04-customer-invalid-file');

  await pick(page, 'locked.pdf', 'application/pdf', makeEncryptedPdf());
  await expect(page.getByRole('alert')).toContainText(/password|protected/i);
  await expectNoOverflow(page, 'encrypted pdf');

  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_BYTES + 1024, 0x20)]);
  await pick(page, 'huge.pdf', 'application/pdf', big);
  await expect(page.getByRole('alert')).toContainText(/large|size|MB/i);
  await expectNoOverflow(page, 'oversized');

  const longName = `${'very-long-document-name-'.repeat(8)}final.pdf`;
  await pick(page, longName, 'application/pdf', await makePdf(2));
  await expect(page.getByText(/2\s*pages\s*·\s*ready/)).toBeVisible();
  await expectNoOverflow(page, 'long filename');
  const nameBox = page.locator('.cx-file-name').first();
  const m = await nameBox.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ov: getComputedStyle(el).textOverflow, ws: getComputedStyle(el).whiteSpace }));
  expect(m.cw).toBeLessThanOrEqual(VIEWPORTS.mobile.width);
  expect(`${m.ov}/${m.ws}`).toMatch(/ellipsis/);
  await shot(page, '05-customer-long-filename');
  await ctx.close();
});
