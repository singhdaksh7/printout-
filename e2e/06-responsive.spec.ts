import { expect, test } from '@playwright/test';
import { SLUG, VIEWPORTS, createOrderViaApi, expectNoOverflow, makePdf, newMobileContext, shot, uiLogin } from './support';

const SIZES = [
  ['360', VIEWPORTS.s360],
  ['430', VIEWPORTS.s430],
  ['768', VIEWPORTS.tablet]
] as const;

for (const [name, vp] of SIZES) {
  test(`responsive ${name}px: customer, tracking and shop screens have no horizontal overflow`, async ({ browser }) => {
    const longName = `${'long-name-'.repeat(10)}.pdf`;
    const order = await createOrderViaApi(SLUG, { name: `Resp ${name}`, fileName: longName });
    const ctx = await newMobileContext(browser, vp);
    const page = await ctx.newPage();
    await page.goto(`/p/${SLUG}`);
    await expectNoOverflow(page, `customer idle ${name}`);
    await page.getByTestId('file-input').setInputFiles({ name: longName, mimeType: 'application/pdf', buffer: await makePdf(4) });
    await expect(page.getByTestId('total')).toBeVisible();
    await page.getByRole('radio', { name: 'Custom' }).click();
    await page.getByPlaceholder(/e\.g\./).fill('1-3');
    await expect(page.getByTestId('total')).toBeVisible();
    await expectNoOverflow(page, `customer configured ${name}`);
    await shot(page, `60-customer-${name}`);
    await page.goto(`/t/${order.trackingToken}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Order');
    await expectNoOverflow(page, `tracking ${name}`);

    await uiLogin(page, 'owner@central.test');
    await expect(page.getByTestId('order-card').first()).toBeVisible();
    await expectNoOverflow(page, `queue ${name}`);
    await shot(page, `61-shop-queue-${name}`, false);
    await page.getByRole('tab', { name: 'New' }).click();
    await page.getByTestId('order-card').filter({ hasText: `Resp ${name}` }).getByRole('link').first().click();
    await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible();
    await expectNoOverflow(page, `order detail ${name}`);
    for (const label of ['Pricing', 'QR', 'Analytics', 'Settings']) {
      await page.getByRole('link', { name: label, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoOverflow(page, `${label} ${name}`);
    }
    await shot(page, `62-shop-settings-${name}`, false);
    await ctx.close();
  });
}
