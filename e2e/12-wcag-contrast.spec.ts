import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ROOT, SEED_PASSWORD } from './env';
import { SLUG, VIEWPORTS, createOrderViaApi, makePdf, uiLogin } from './support';

// Explicit WCAG 2.1 AA contrast audit, independent of axe: computes the rendered contrast of every visible text element against its
// effective background (alpha-blended up the ancestor chain) on the main screens and states, plus focus rings and form validation.
// Text: 4.5:1 (3:1 for large text: >= 24px, or >= 18.66px bold). Non-text (focus ring, input border): 3:1. Disabled controls are exempt (1.4.3).
// Writes docs/visual-qa/contrast-report.json.

interface Finding { screen: string; selector: string; text: string; ratio: number; need: number; fg: string; bg: string }
const findings: Finding[] = [];
const checked: Record<string, number> = {};

async function auditText(page: Page, screen: string) {
  // measure end states: a control that has just been enabled is still mid-transition for 150 ms
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  await page.waitForTimeout(100);
  const res = await page.evaluate(() => {
    const parse = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 }; };
    const blend = (top: { r: number; g: number; b: number; a: number }, bot: { r: number; g: number; b: number }) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a) });
    const lum = (c: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const effBg = (el: Element) => {
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.push(e);
      let base = { r: 255, g: 255, b: 255 };
      for (const e of chain.reverse()) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) base = blend(c, base); }
      return base;
    };
    const out: { sel: string; text: string; ratio: number; need: number; fg: string; bg: string }[] = [];
    let n = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || seen.has(el) || !node.textContent?.trim()) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest('[disabled], [aria-disabled="true"], script, style, noscript, svg')) continue;
      let hidden = false;
      for (let e: Element | null = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || (e as HTMLElement).hidden) hidden = true; }
      if (hidden) continue;
      const fgc = parse(cs.color); if (!fgc) continue;
      const bg = effBg(el);
      // inherited opacity (e.g. a faded card) lightens the text towards the background
      let op = 1; for (let e: Element | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      const fg = blend({ ...fgc, a: fgc.a * op }, bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      n++;
      if (ratio < need) out.push({ sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''), text: (node.textContent ?? '').trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, need, fg: `rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)})`, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})` });
    }
    return { n, out };
  });
  checked[screen] = res.n;
  for (const f of res.out) findings.push({ screen, selector: f.sel, text: f.text, ratio: f.ratio, need: f.need, fg: f.fg, bg: f.bg });
}

/** Tab to the first focusable control and measure its focus indicator against the surrounding background (needs 3:1). */
async function auditFocusRing(page: Page, screen: string) {
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  const r = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const parse = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m![1]!.split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 }; };
    const lum = (c: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    let base = { r: 255, g: 255, b: 255 };
    const chain: Element[] = []; for (let e: Element | null = el.parentElement; e; e = e.parentElement) chain.push(e);
    for (const e of chain.reverse()) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; }
    const ring = parse(cs.outlineColor);
    const width = parseFloat(cs.outlineWidth);
    const [hi, lo] = [lum(ring), lum(base)].sort((a, b) => b - a) as [number, number];
    return { tag: el.tagName.toLowerCase() + '.' + String(el.className) + ' ring ' + cs.outlineColor, style: cs.outlineStyle, width, ratio: (hi + 0.05) / (lo + 0.05) };
  });
  expect(r, `${screen}: something takes focus`).not.toBeNull();
  expect(r!.style, `${screen}: focus ring is drawn`).not.toBe('none');
  expect(r!.width, `${screen}: focus ring is at least 2px`).toBeGreaterThanOrEqual(2);
  expect(r!.ratio, `${screen}: focus ring ${r!.tag} contrast`).toBeGreaterThanOrEqual(3);
}

test.afterAll(() => {
  const dir = path.join(ROOT, 'docs', 'visual-qa');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'contrast-report.json'), JSON.stringify({ textElementsChecked: checked, violations: findings }, null, 1));
});

test('WCAG AA contrast: customer, shop and admin screens and states', async ({ browser }) => {
  test.setTimeout(300_000);
  const order = await createOrderViaApi(SLUG, { name: 'Contrast', pages: 4 });
  await createOrderViaApi(SLUG, { name: 'Contrast 2', pages: 2, colourMode: 'colour' });
  const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await ctx.newPage();
  const settle = async () => { await expect(page.locator('[aria-busy="true"], .page-loading')).toHaveCount(0); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300); };

  // customer: idle, configured, validation error, tracking, not found
  await page.goto(`/p/${SLUG}`); await settle();
  await auditText(page, 'customer landing');
  await auditFocusRing(page, 'customer landing');
  await page.getByTestId('file-input').setInputFiles({ name: 'c.pdf', mimeType: 'application/pdf', buffer: await makePdf(6) });
  await expect(page.getByTestId('total')).toBeVisible(); await settle();
  await auditText(page, 'customer options and quote');
  await page.locator('label.pb-seg__opt', { hasText: 'Custom' }).click();
  await page.getByPlaceholder(/e\.g\./).fill('9-1');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await auditText(page, 'customer validation error');
  // invalid input border and error text keep their contrast (border 3:1 against the card)
  await page.getByPlaceholder(/e\.g\./).blur();
  await expect(page.locator('.pb-control--invalid').first()).toHaveCSS('border-top-color', 'rgb(180, 35, 24)');
  await page.goto(`/t/${order.trackingToken}`); await settle();
  await auditText(page, 'customer tracking');
  await page.goto('/p/no-such-shop'); await settle();
  await auditText(page, 'customer not found');

  // shop: login (with error), queue, notifications, detail, history, revenue, devices, rate card, QR, settings
  await page.goto('/shop/login'); await settle();
  await auditText(page, 'shop login');
  await page.getByLabel('Email').fill('owner@central.test');
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await auditText(page, 'shop login error');
  await uiLogin(page, 'owner@central.test');
  await expect(page).toHaveURL(/\/shop$/); await settle();
  await auditText(page, 'shop queue');
  await auditFocusRing(page, 'shop queue (navy sidebar)');
  await page.getByRole('button', { name: /^Notifications/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await auditText(page, 'shop notifications panel');
  await page.keyboard.press('Escape');
  const href = await page.locator('main a[href^="/shop/orders/"]').first().getAttribute('href');
  for (const [name, url] of [['order detail', href ?? '/shop'], ['history', '/shop/history'], ['revenue', '/shop/analytics'], ['devices', '/shop/devices'], ['rate card', '/shop/pricing'], ['QR', '/shop/qr'], ['settings', '/shop/settings']] as const) {
    await page.goto(url); await settle();
    await auditText(page, `shop ${name}`);
  }
  // rate card validation state
  await page.goto('/shop/pricing'); await settle();
  const price = page.locator('input[inputmode="decimal"]').first();
  await price.fill('abc'); await price.blur();
  await auditText(page, 'shop rate card validation');

  // admin
  await page.context().clearCookies();
  await page.goto('/admin/login'); await settle();
  await auditText(page, 'admin login');
  await page.getByLabel('Email').fill('admin@printout.test');
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/); await settle();
  await auditText(page, 'admin dashboard');
  await auditFocusRing(page, 'admin dashboard (navy sidebar)');
  for (const [name, url] of [['shops', '/admin/shops'], ['create shop', '/admin/shops/new'], ['orders', '/admin/orders'], ['subscriptions', '/admin/subscriptions'], ['plans', '/admin/plans'], ['audit log', '/admin/audit'], ['account', '/admin/account']] as const) {
    await page.goto(url); await settle();
    await auditText(page, `admin ${name}`);
  }
  await ctx.close();

  const summary = findings.map((f) => `${f.screen}: <${f.selector}> "${f.text}" ${f.ratio}:1 < ${f.need}:1 (${f.fg} on ${f.bg})`);
  expect(summary, `contrast failures:\n${summary.join('\n')}`).toEqual([]);
});
