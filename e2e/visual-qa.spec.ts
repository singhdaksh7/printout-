import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ROOT, SEED_PASSWORD, WEB } from './env';
import { SLUG, VIEWPORTS, createOrderViaApi, makePdf, newMobileContext, uiLogin } from './support';

// Visual QA capture: every Customer, Shopkeeper and Admin route at 360, 390, 768 and 1440 px, with an axe WCAG 2.x A/AA scan, an
// overflow check and console-error capture per screen. Opt-in (it is a report generator, not a regression gate):
//   VQA_LABEL=after pnpm e2e -g "visual QA"     -> docs/visual-qa/after/*.png and docs/visual-qa/after/report.json
const LABEL = process.env.VQA_LABEL;
const OUT = path.join(ROOT, process.env.VQA_OUT ?? path.join('docs', 'visual-qa'), LABEL ?? 'after');
const WIDTHS = [
  ['360', VIEWPORTS.s360],
  ['390', VIEWPORTS.mobile],
  ['768', VIEWPORTS.tablet],
  ['1440', VIEWPORTS.desktop]
] as const;

interface Row { screen: string; width: string; axe: string[]; overflow: boolean; console: string[] }
const rows: Row[] = [];

async function ctxFor(browser: Parameters<typeof newMobileContext>[0], vp: { width: number; height: number }): Promise<BrowserContext> {
  return vp.width <= 430 ? newMobileContext(browser, vp) : browser.newContext({ viewport: vp, baseURL: WEB });
}

async function capture(page: Page, screen: string, width: string, logs: string[]) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[aria-busy="true"], .page-loading')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${screen}-${width}.png`), fullPage: true });
  rows.push({
    screen, width, overflow: m.sw > m.iw,
    axe: results.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0]?.target.join(' ')}`),
    console: logs.splice(0)
  });
}

function watch(page: Page) {
  const logs: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') logs.push(msg.text()); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  return logs;
}

test.describe('visual QA', () => {
  test.skip(!LABEL, 'set VQA_LABEL=before|after to run');
  test.setTimeout(900_000);

  test.afterAll(() => {
    if (!LABEL) return;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rows, null, 1));
  });

  test('customer routes', async ({ browser }) => {
    const order = await createOrderViaApi(SLUG, { name: 'Visual QA', pages: 6 });
    for (const [w, vp] of WIDTHS) {
      const ctx = await ctxFor(browser, vp);
      const page = await ctx.newPage();
      const logs = watch(page);
      await page.goto(`/p/${SLUG}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Central Print' })).toBeVisible();
      await capture(page, 'customer-1-landing', w, logs);
      await page.getByTestId('file-input').setInputFiles({ name: 'Project_report.pdf', mimeType: 'application/pdf', buffer: await makePdf(8) });
      await expect(page.getByTestId('total')).toBeVisible();
      await capture(page, 'customer-2-options-quote', w, logs);
      await page.locator('label.pb-seg__opt', { hasText: 'Custom' }).click();
      await page.getByPlaceholder(/e\.g\./).fill('9-1');
      await expect(page.getByRole('alert').first()).toBeVisible();
      await capture(page, 'customer-3-validation-error', w, logs);
      await page.getByPlaceholder(/e\.g\./).fill('1-4');
      await page.getByRole('button', { name: 'Place order' }).click();
      await expect(page).toHaveURL(/\/t\//);
      await capture(page, 'customer-4-confirmation', w, logs);
      await page.goto(`/t/${order.trackingToken}`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Order');
      await capture(page, 'customer-5-tracking', w, logs);
      await page.goto('/p/no-such-shop');
      await expect(page.getByRole('heading', { level: 1, name: 'Shop not found' })).toBeVisible();
      await capture(page, 'customer-6-not-found', w, logs);
      await ctx.close();
    }
  });

  test('shopkeeper routes', async ({ browser }) => {
    for (let i = 0; i < 3; i++) await createOrderViaApi(SLUG, { name: `Queue ${i}`, pages: 3 + i, colourMode: i === 1 ? 'colour' : 'bw' });
    for (const [w, vp] of WIDTHS) {
      const ctx = await ctxFor(browser, vp);
      const page = await ctx.newPage();
      const logs = watch(page);
      await page.goto('/shop/login');
      await capture(page, 'shop-0-login', w, logs);
      await uiLogin(page, 'owner@central.test');
      await expect(page).toHaveURL(/\/shop$/);
      await expect(page.locator('main')).toBeVisible();
      await page.waitForTimeout(800);
      await capture(page, 'shop-1-queue', w, logs);
      await page.getByRole('button', { name: /^Notifications/ }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await capture(page, 'shop-2-notifications', w, logs);
      await page.keyboard.press('Escape');
      const href = await page.locator('main a[href^="/shop/orders/"]').first().getAttribute('href');
      const routes = [['3-order-detail', href ?? '/shop'], ['4-history', '/shop/history'], ['5-revenue', '/shop/analytics'], ['6-devices', '/shop/devices'], ['7-rate-card', '/shop/pricing'], ['8-qr', '/shop/qr'], ['9-settings', '/shop/settings']];
      for (const [name, url] of routes) {
        await page.goto(url);
        await page.waitForTimeout(900);
        await capture(page, `shop-${name}`, w, logs);
      }
      await ctx.close();
    }
  });

  test('admin routes', async ({ browser }) => {
    for (const [w, vp] of WIDTHS) {
      const ctx = await ctxFor(browser, vp);
      const page = await ctx.newPage();
      const logs = watch(page);
      await page.goto('/admin/login');
      await capture(page, 'admin-0-login', w, logs);
      await page.getByLabel('Email').fill('admin@printout.test');
      await page.getByLabel('Password').fill(SEED_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/admin$/);
      await page.waitForTimeout(900);
      await capture(page, 'admin-1-dashboard', w, logs);
      await page.goto('/admin/shops');
      await page.waitForTimeout(700);
      await capture(page, 'admin-2-shops', w, logs);
      const shop = await page.locator('main a[href^="/admin/shops/"]:not([href$="/new"])').first().getAttribute('href');
      const routes = [['3-shop-new', '/admin/shops/new'], ['4-shop-detail', shop ?? '/admin/shops'], ['5-orders', '/admin/orders'], ['6-subscriptions', '/admin/subscriptions'], ['7-plans', '/admin/plans'], ['8-audit', '/admin/audit'], ['9-account', '/admin/account']];
      for (const [name, url] of routes) {
        await page.goto(url);
        await page.waitForTimeout(900);
        await capture(page, `admin-${name}`, w, logs);
      }
      await ctx.close();
    }
  });
});
