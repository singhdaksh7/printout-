import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ART, VIEWPORTS, createOrderViaApi, dbQuery, expectNoOverflow, newMobileContext, uiLogin } from './support';

// Shopkeeper Order History: desktop table and phone cards, date presets, custom range, status filter, search, CSV export,
// tenant isolation, keyboard use, WCAG 2.1 A/AA scans and screenshots (compare with docs/design/3.pdf p15).
// Uses the isolated e2e database like the other specs.

const FILES = {
  today: 'HX_Marksheet_2026.pdf',
  formula: '=HX_SUM(1+1)@evil.pdf',
  cancelled: 'HX_Bank_form.pdf',
  yesterday: 'HX_Yesterday_notes.pdf',
  old: 'HX_Old_invoice_10_days.pdf',
  other: 'HX_metro-secret.pdf'
};

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).include('#pb-main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe violations on ${label}\n${summary.join('\n')}`).toEqual([]);
}
const snap = (page: Page, name: string, fullPage = true) => page.screenshot({ path: path.join(ART, `history-${name}.png`), fullPage });
const sqlName = (s: string) => s.replace(/'/g, "''");
/** Moves the order carrying this file to a fixed state (private e2e database only). */
function pin(file: string, set: { daysAgo?: number; status?: string; deleted?: boolean; initiated?: boolean }) {
  const f = sqlName(file);
  const id = dbQuery(`select o.id from "Order" o join "Document" d on d.id = o."documentId" where d."originalFilename" = '${f}'`);
  expect(id, `order for ${file}`).not.toBe('');
  if (set.daysAgo !== undefined) dbQuery(`update "Order" set "createdAt" = now() - interval '${set.daysAgo} days' where id = '${id}'`);
  if (set.status) dbQuery(`update "Order" set status = '${set.status}' where id = '${id}'`);
  if (set.initiated) dbQuery(`update "Document" set "printInitiatedAt" = now() where id = (select "documentId" from "Order" where id = '${id}')`);
  if (set.deleted) dbQuery(`update "Document" set status = 'DELETED', "deletedAt" = now() where id = (select "documentId" from "Order" where id = '${id}')`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await createOrderViaApi('central-print', { fileName: FILES.today, name: 'Asha' });
  await createOrderViaApi('central-print', { fileName: FILES.formula });
  await createOrderViaApi('central-print', { fileName: FILES.cancelled });
  await createOrderViaApi('central-print', { fileName: FILES.yesterday });
  await createOrderViaApi('central-print', { fileName: FILES.old });
  await createOrderViaApi('metro-copies', { fileName: FILES.other });
  pin(FILES.today, { status: 'PRINTING', initiated: true, deleted: true });
  pin(FILES.cancelled, { status: 'CANCELLED' });
  pin(FILES.yesterday, { daysAgo: 1, status: 'EXPIRED' });
  pin(FILES.old, { daysAgo: 10 });
});

/** Clicks a segmented-control option the way a user does: its visible label (the native radio is visually hidden). */
const pick = (page: Page, name: string) => page.locator('label.pb-seg__opt', { hasText: name }).click();
const rowOf = (page: Page, file: string) => page.getByTestId('history-row').filter({ hasText: file });

/** Other specs create many orders today, so each test narrows the list to this spec's own files (all contain "HX_"). */
const MINE = 'HX_';
async function openHistory(page: Page, opts: { narrow?: boolean } = {}) {
  await uiLogin(page, 'owner@central.test');
  await page.getByRole('navigation', { name: 'Shop sections' }).or(page.getByRole('navigation', { name: 'Shop sections, phone' })).getByRole('link', { name: 'History' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  if (opts.narrow !== false) {
    const narrowed = page.waitForResponse((r) => r.url().includes('/shop/orders/history?') && r.url().includes(`q=${MINE}`));
    await page.getByRole('searchbox', { name: 'Code or file name' }).fill(MINE);
    await narrowed;
  }
}

test('desktop: table, summary, filters, search, keyboard, tenant isolation, a11y', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openHistory(page);
  await expect(page).toHaveURL(/\/shop\/history$/);
  await expect(rowOf(page, FILES.today)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  // default = Today (IST): today's orders only, nothing from yesterday, 10 days ago or another shop
  await expect(rowOf(page, FILES.formula)).toBeVisible();
  await expect(rowOf(page, FILES.cancelled)).toBeVisible();
  await expect(rowOf(page, FILES.yesterday)).toHaveCount(0);
  await expect(rowOf(page, FILES.old)).toHaveCount(0);
  await expect(page.getByText(FILES.other)).toHaveCount(0);
  const table = page.getByRole('table', { name: /Order history, Today/ });
  for (const h of ['Time', 'Code', 'File', 'Pages × copies', 'Settings', 'Status', 'By', 'File deleted']) await expect(table.getByRole('columnheader', { name: h, exact: true })).toBeVisible();
  const done = rowOf(page, FILES.today);
  await expect(done.getByTestId('print-initiated')).toContainText('Print initiated');
  await expect(done.getByText('Print started')).toBeVisible();
  await expect(page.locator('#pb-main')).not.toContainText(/\bPrinted\b/);
  await expect(page.getByRole('button', { name: /^(Print|Reprint|Save file)$/ })).toHaveCount(0);

  const stats = page.getByLabel(/Summary for Today/);
  await expect(stats).toContainText('Print initiated');
  await expect(stats).not.toContainText('–'); // summary has loaded (no placeholder dashes)
  await expect(stats.getByText('3', { exact: true }).first()).toBeVisible(); // today's three orders
  await expect(stats.getByText('Files deleted', { exact: true })).toBeVisible();
  await expectNoOverflow(page, 'history desktop');
  await scan(page, 'history today desktop');
  await snap(page, 'desktop-today');

  // keyboard: the date range is a radio group; arrow keys move and select
  await page.getByRole('radio', { name: 'Today' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Yesterday' })).toBeChecked();
  await expect(rowOf(page, FILES.yesterday)).toBeVisible();
  await expect(rowOf(page, FILES.today)).toHaveCount(0);
  await expect(rowOf(page, FILES.yesterday).getByText('Expired')).toBeVisible();
  await expect(rowOf(page, FILES.yesterday).getByText('Automatic')).toBeVisible();
  await scan(page, 'history yesterday desktop');

  await pick(page, 'Last 7 days');
  await expect(rowOf(page, FILES.today)).toBeVisible();
  await expect(rowOf(page, FILES.yesterday)).toBeVisible();
  await expect(rowOf(page, FILES.old)).toHaveCount(0);
  // several days: the date is shown with the time
  await expect(rowOf(page, FILES.yesterday).locator('time').first()).toContainText(/\d{2} \w{3}, \d{2}:\d{2}/);
  await snap(page, 'desktop-last7');

  // custom range around the old order, with validation
  await pick(page, 'Custom');
  const tenAgo = dbQuery(`select to_char((now() at time zone 'Asia/Kolkata') - interval '10 days', 'YYYY-MM-DD')`);
  await page.getByLabel('From', { exact: true }).fill(tenAgo);
  await page.getByLabel('To', { exact: true }).fill(tenAgo);
  await expect(rowOf(page, FILES.old)).toBeVisible();
  await expect(rowOf(page, FILES.today)).toHaveCount(0);
  await page.getByLabel('From', { exact: true }).fill('');
  await expect(page.getByText(/Choose both a start and an end date/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  await scan(page, 'history custom invalid desktop');
  await snap(page, 'desktop-custom-invalid');
  await pick(page, 'Today');

  // status filter and search (job code and file name), case-insensitive
  await page.getByLabel('Status').selectOption({ label: 'Cancelled' });
  await expect(rowOf(page, FILES.cancelled)).toBeVisible();
  await expect(rowOf(page, FILES.today)).toHaveCount(0);
  await page.getByLabel('Status').selectOption({ label: 'All statuses' });
  const search = page.getByRole('searchbox', { name: 'Code or file name' });
  await search.fill('marksheet');
  await expect(rowOf(page, FILES.today)).toBeVisible();
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  const code = (await rowOf(page, FILES.today).getByRole('link').first().innerText()).replace('#', '');
  await search.fill(code.toLowerCase());
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  // another shop's file is never found, and an empty result is explained
  await search.fill('metro-secret');
  await expect(page.getByRole('heading', { name: 'No orders match these filters' })).toBeVisible();
  await scan(page, 'history empty desktop');
  await snap(page, 'desktop-empty');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toHaveValue('');
  await search.fill(MINE); // narrow again to this spec's own files
  await expect(rowOf(page, FILES.today)).toBeVisible();

  // a row opens its order detail by keyboard (the code is a real link)
  await rowOf(page, FILES.cancelled).getByRole('link').first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/shop\/orders\//);
});

test('desktop: CSV export is metadata only, formula-safe and tenant-isolated', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openHistory(page);
  await expect(rowOf(page, FILES.today)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^order-history-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/);
  const file = await download.path();
  const csv = readFileSync(file!, 'utf8').replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toContain('"Job code"');
  expect(lines).toHaveLength(1 + 3); // the three of today's orders
  expect(csv).toContain(FILES.today);
  expect(csv).toContain(`"'=HX_SUM(1+1)@evil.pdf"`); // neutralised, not a live formula
  expect(csv).not.toMatch(/(^|,)"=/m);
  expect(csv).not.toContain(FILES.other); // other tenant
  expect(csv).not.toContain(FILES.yesterday); // outside the range
  expect(csv).not.toContain('Asha'); // customer reference is not exported
  await expect(page.getByText(/order details only, never file contents/)).toBeVisible();
  await scan(page, 'history export note desktop');
});

test('desktop: load, error and retry states are accessible', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  let failing = true;
  await page.route('**/api/v1/shop/orders/history?*', (route) => (failing ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }) }) : route.continue()));
  await openHistory(page);
  const alert = page.getByRole('alert').filter({ hasText: /server had a problem/i });
  await expect(alert).toBeVisible();
  await scan(page, 'history error desktop');
  await snap(page, 'desktop-error');
  failing = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(rowOf(page, FILES.today)).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('Analytics is preserved and reachable', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openHistory(page);
  await page.getByRole('navigation', { name: 'Shop sections' }).getByRole('link', { name: 'Analytics' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: 'View analytics' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
});

for (const [name, vp] of [['390', VIEWPORTS.mobile], ['360', VIEWPORTS.s360]] as const) {
  test(`phone ${name}px: cards, tab bar, no overflow, a11y`, async ({ browser }) => {
    const ctx = await newMobileContext(browser, vp);
    const page = await ctx.newPage();
    await openHistory(page);
    const bar = page.getByRole('navigation', { name: 'Shop sections, phone' });
    await expect(bar.getByRole('link', { name: 'History' })).toHaveAttribute('aria-current', 'page');
    expect(await bar.getByRole('link').count()).toBe(5);
    await expect(page.getByRole('table')).toHaveCount(0);
    const list = page.getByRole('list', { name: /Order history, Today/ });
    await expect(list).toBeVisible();
    const card = rowOf(page, FILES.today);
    await expect(card).toBeVisible();
    await expect(card.getByText('File deleted')).toBeVisible();
    await expect(card.getByText('Print started')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectNoOverflow(page, `history phone ${name}`);
    await scan(page, `history phone ${name}`);
    await snap(page, `phone-${name}`);

    await pick(page, 'Last 7 days');
    await expect(rowOf(page, FILES.yesterday)).toBeVisible();
    await pick(page, 'Custom');
    await expectNoOverflow(page, `history phone custom ${name}`);
    await scan(page, `history phone custom ${name}`);
    await snap(page, `phone-${name}-custom`);
    // tap targets of the primary controls are at least 24px (WCAG 2.2 AA minimum; the design aims for 44)
    for (const b of [page.getByRole('button', { name: 'Export CSV' })]) {
      const box = await b.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(24);
    }
    await ctx.close();
  });
}
