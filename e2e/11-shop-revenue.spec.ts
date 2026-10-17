import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ART, VIEWPORTS, createOrderViaApi, dbQuery, expectNoOverflow, newMobileContext, uiLogin } from './support';

// Shopkeeper order value report (estimated quotes only). Seeds orders on fixed past IST days so figures are exact even though
// other specs add orders for "today" to the same disposable e2e database.
//   day D   (60 days ago): central 12.50 (colour, 2 copies x 5 pages, print started) + 7.50 (B&W, 3 pages) + cancelled 9.99; metro 99.99
//   day D-1: central 3.00        day D-3: central 1.00 (so the previous window is complete)

const FILES = { a: 'RV_colour_A.pdf', b: 'RV_bw_B.pdf', cancelled: 'RV_cancelled.pdf', prev: 'RV_prev.pdf', old: 'RV_old.pdf', metro: 'RV_metro_secret.pdf' };
let D = '';

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).include('#pb-main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe violations on ${label}\n${summary.join('\n')}`).toEqual([]);
}
const snap = (page: Page, name: string) => page.screenshot({ path: path.join(ART, `revenue-${name}.png`), fullPage: true });

function pin(file: string, o: { daysAgo: number; paise: number; status?: string; pages: number; copies?: number; colour?: string; started?: boolean }) {
  const id = dbQuery(`select o.id from "Order" o join "Document" d on d.id = o."documentId" where d."originalFilename" = '${file}'`);
  expect(id, `order for ${file}`).not.toBe('');
  const at = `((date_trunc('day', now() at time zone 'Asia/Kolkata') - interval '${o.daysAgo} days') + interval '10 hours') at time zone 'Asia/Kolkata'`;
  dbQuery(
    `update "Order" set "createdAt" = ${at}, "totalPaise" = ${o.paise}, status = '${o.status ?? 'NEW'}', ` +
      `"priceSnapshot" = "priceSnapshot" || '{"selectedPageCount": ${o.pages}}'::jsonb, ` +
      `"printOptionsSnapshot" = "printOptionsSnapshot" || '{"copies": ${o.copies ?? 1}, "colourMode": "${o.colour ?? 'bw'}"}'::jsonb where id = '${id}'`
  );
  if (o.started) dbQuery(`update "Document" set "printInitiatedAt" = now() where id = (select "documentId" from "Order" where id = '${id}')`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  for (const [f, shop] of [[FILES.a, 'central-print'], [FILES.b, 'central-print'], [FILES.cancelled, 'central-print'], [FILES.prev, 'central-print'], [FILES.old, 'central-print'], [FILES.metro, 'metro-copies']] as const) {
    await createOrderViaApi(shop, { fileName: f });
  }
  pin(FILES.a, { daysAgo: 60, paise: 1250, pages: 5, copies: 2, colour: 'colour', status: 'PRINTING', started: true });
  pin(FILES.b, { daysAgo: 60, paise: 750, pages: 3 });
  pin(FILES.cancelled, { daysAgo: 60, paise: 999, pages: 9, status: 'CANCELLED' });
  pin(FILES.prev, { daysAgo: 61, paise: 300, pages: 1 });
  pin(FILES.old, { daysAgo: 63, paise: 100, pages: 1 });
  pin(FILES.metro, { daysAgo: 60, paise: 9999, pages: 1 });
  D = dbQuery(`select to_char((now() at time zone 'Asia/Kolkata') - interval '60 days', 'YYYY-MM-DD')`);
});

const pick = (page: Page, name: string) => page.locator('label.pb-seg__opt', { hasText: name }).click();
async function openReport(page: Page, email = 'owner@central.test') {
  await uiLogin(page, email);
  await expect(page.getByRole('navigation', { name: /Shop sections/ }).first()).toBeVisible();
  await page.goto('/shop/analytics');
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Order value report' })).toBeVisible();
}
async function chooseDay(page: Page, ymd: string) {
  await pick(page, 'Custom');
  const loaded = page.waitForResponse((r) => r.url().includes('/shop/analytics/revenue?') && r.url().includes(`from=${ymd}`) && r.url().includes(`to=${ymd}`));
  await page.getByLabel('From', { exact: true }).fill(ymd);
  await page.getByLabel('To', { exact: true }).fill(ymd);
  await loaded;
}
const stat = (page: Page, label: string) => page.getByLabel(/^Summary for /).locator('.pb-stat', { has: page.getByText(label, { exact: true }) });

test('desktop: exact figures, definitions, chart, table, breakdowns, comparison, filters, a11y', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openReport(page);
  await page.evaluate(() => document.fonts.ready);

  // presets exist and query the API with IST calendar dates
  for (const p of ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Custom']) await expect(page.getByRole('radio', { name: p })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Last 7 days' })).toBeChecked();
  await expect(page.getByText(/does not record cash or online payments/)).toBeVisible();

  await chooseDay(page, D);
  const summary = page.getByLabel(/^Summary for /);
  await expect(summary).toBeVisible();
  await expect(stat(page, 'Estimated order value')).toContainText('₹20.00');
  await expect(stat(page, 'Orders')).toContainText('3');
  await expect(stat(page, 'Print started')).toContainText('1');
  await expect(stat(page, 'Pages requested')).toContainText('13');
  await expect(stat(page, 'Average estimated order value')).toContainText('₹10.00');
  await expect(stat(page, 'Cancelled or expired')).toContainText('1 / 0');
  await expect(stat(page, 'Cancelled or expired')).toContainText('₹9.99 is not counted');
  await expect(page.locator('#pb-main')).not.toContainText('99.99'); // another shop's order
  await expect(page.locator('#pb-main')).not.toContainText(/revenue|money earned|profit/i);

  // comparison window is stated and honest: D-1 had ₹3.00, so (2000-300)/300 = +566.7%
  const cmp = page.getByTestId('comparison');
  await expect(cmp).toContainText('Compared with the previous 1 day');
  await expect(cmp).toContainText('estimated value +566.7%');
  await expect(cmp).toContainText('Previously ₹3.00 from 1 order');

  // chart with accessible name, plus the exact table behind it
  await expect(page.getByRole('img', { name: /Estimated order value per day in rupees/ })).toBeVisible();
  await page.getByText('View as table').click();
  const table = page.getByRole('table', { name: /Daily order value and volume/ });
  await expect(table.getByRole('row').filter({ hasText: '₹20.00' })).toHaveCount(1);

  // breakdowns
  const colour = page.getByRole('list', { name: 'Black & white vs colour' });
  await expect(colour).toContainText('Colour');
  await expect(colour).toContainText('1 order · ₹12.50');
  await expect(colour).toContainText('1 order · ₹7.50');
  await expect(page.getByRole('list', { name: 'Orders by status' })).toContainText('Cancelled');
  await expectNoOverflow(page, 'revenue desktop');
  await scan(page, 'revenue desktop');
  await snap(page, 'desktop');

  // a multi-day window with an incomplete baseline shows no percentage
  await page.getByLabel('From', { exact: true }).fill(dbQuery(`select to_char((now() at time zone 'Asia/Kolkata') - interval '63 days', 'YYYY-MM-DD')`));
  await expect(stat(page, 'Estimated order value')).toContainText('₹24.00'); // D-3 1.00 + D-1 3.00 + D 20.00
  await expect(page.getByTestId('comparison')).toContainText(/No comparison|Compared with/);
  await snap(page, 'desktop-multi-day');

  // an invalid custom range is explained locally and blocks the export
  await page.getByLabel('From', { exact: true }).fill('');
  await expect(page.getByText(/Choose both a start and an end date/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
});

test('desktop: the chosen range is remembered, keyboard changes it, and an empty period is explained', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openReport(page);
  await page.getByRole('radio', { name: 'Last 7 days' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Last 30 days' })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Last 30 days' })).toBeChecked();
  await pick(page, 'Custom');
  const far = dbQuery(`select to_char((now() at time zone 'Asia/Kolkata') - interval '300 days', 'YYYY-MM-DD')`);
  await page.getByLabel('From', { exact: true }).fill(far);
  await page.getByLabel('To', { exact: true }).fill(far);
  await expect(page.getByRole('heading', { name: 'No orders in this period' })).toBeVisible();
  await scan(page, 'revenue empty');
  await snap(page, 'desktop-empty');
});

test('desktop: CSV export holds quoted values only, no file names, no other shop', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openReport(page);
  await chooseDay(page, D);
  await expect(stat(page, 'Estimated order value')).toContainText('₹20.00');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toBe(`estimated-order-value-${D}_to_${D}.csv`);
  const csv = readFileSync((await download.path())!, 'utf8').replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  expect(lines).toHaveLength(1 + 3); // colour A, B and the cancelled order
  expect(lines[0]).toContain('Estimated order value (INR)');
  expect(lines[0]).not.toMatch(/collected|paid|revenue/i);
  expect(csv).toContain('12.50');
  expect(csv).toContain('7.50');
  expect(csv).toContain('"No"'); // cancelled row is listed but not counted
  for (const f of Object.values(FILES)) expect(csv).not.toContain(f);
  expect(csv).not.toContain('99.99');
  await expect(page.getByText(/quoted order values only/)).toBeVisible();
  await scan(page, 'revenue export note');
});

test('another shop sees only its own figures', async ({ browser }) => {
  const ctx = await newMobileContext(browser, VIEWPORTS.desktop);
  const page = await ctx.newPage();
  await openReport(page, 'owner@metro.test');
  await chooseDay(page, D);
  await expect(stat(page, 'Estimated order value')).toContainText('₹99.99');
  await expect(stat(page, 'Orders')).toContainText('1');
  await expect(page.locator('#pb-main')).not.toContainText('12.50');
  await ctx.close();
});

test('error state offers Retry and recovers', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  let failing = true;
  await page.route('**/api/v1/shop/analytics/revenue?*', (route) => (failing ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }) }) : route.continue()));
  await openReport(page);
  const alert = page.getByRole('alert').filter({ hasText: /server had a problem/i });
  await expect(alert).toBeVisible();
  await scan(page, 'revenue error');
  failing = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByLabel(/^Summary for /).or(page.getByRole('heading', { name: 'No orders in this period' }))).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('existing Analytics and History keep working', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openReport(page);
  await expect(page.getByText('Orders today')).toBeVisible();
  await page.getByRole('navigation', { name: 'Shop sections' }).getByRole('link', { name: 'History' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  await page.getByRole('link', { name: 'View analytics' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Order value report' })).toBeVisible();
});

for (const [name, vp] of [['768', VIEWPORTS.tablet], ['390', VIEWPORTS.mobile], ['360', VIEWPORTS.s360]] as const) {
  test(`${name}px: stacked layout, no overflow, a11y`, async ({ browser }) => {
    const ctx = await newMobileContext(browser, vp);
    const page = await ctx.newPage();
    await openReport(page);
    await chooseDay(page, D);
    await expect(stat(page, 'Estimated order value')).toContainText('₹20.00');
    await page.getByText('View as table').click();
    await page.evaluate(() => document.fonts.ready);
    await expectNoOverflow(page, `revenue ${name}`);
    await scan(page, `revenue ${name}`);
    await snap(page, name);
    const box = await page.getByRole('button', { name: 'Export CSV' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await ctx.close();
  });
}
