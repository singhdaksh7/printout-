import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { makeEncryptedPdf, makeExe, makeJpeg, makePdf, makePng } from '../apps/api/test/fixtures/make';
import { API, ROOT, SEED_PASSWORD, WEB } from './env';

export { makeEncryptedPdf, makeExe, makeJpeg, makePdf, makePng };
export const SLUG = 'central-print';
export const ART = path.join(ROOT, 'e2e', 'artifacts');
const STATE = path.join(ROOT, 'e2e', '.state.json');

export const readState = (): Record<string, any> => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
export const writeState = (patch: Record<string, unknown>) => writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }));

export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  s360: { width: 360, height: 740 },
  s430: { width: 430, height: 932 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 }
};

/** document.documentElement.scrollWidth must not exceed the viewport. */
export async function expectNoOverflow(page: Page, label = '') {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth }));
  expect(m.sw, `horizontal overflow on ${label || page.url()} (scrollWidth ${m.sw} > innerWidth ${m.iw})`).toBeLessThanOrEqual(m.iw);
  expect(m.bw, `body overflow ${label}`).toBeLessThanOrEqual(m.iw);
}

export async function shot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: path.join(ART, `${name}.png`), fullPage });
}

// ---- API helpers (Node side, talks to the API directly) ----
export async function jfetch(url: string, init: RequestInit & { json?: unknown } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.json ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) },
    body: init.json ? JSON.stringify(init.json) : (init.body as BodyInit | undefined)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export async function uploadViaApi(slug: string, bytes: Buffer, fileName = 'e2e.pdf', mime = 'application/pdf') {
  const init = await jfetch(`${API}/api/v1/public/shops/${slug}/uploads/initiate`, { method: 'POST', json: { fileName, byteSize: bytes.length, declaredMimeType: mime } });
  if (init.status !== 200) throw new Error(`initiate ${init.status} ${JSON.stringify(init.body)}`);
  const { uploadId, uploadUrl } = init.body.data;
  const put = await fetch(new URL(uploadUrl, API), { method: 'PUT', body: bytes, headers: { 'content-type': mime } });
  if (put.status !== 200) throw new Error(`put ${put.status}`);
  const done = await jfetch(`${API}/api/v1/public/shops/${slug}/uploads/${uploadId}/complete`, { method: 'POST' });
  if (done.status !== 200) throw new Error(`complete ${done.status} ${JSON.stringify(done.body)}`);
  return done.body.data as { documentId: string; pageCount: number };
}

export async function createOrderViaApi(
  slug = SLUG,
  opts: { pages?: number; name?: string; fileName?: string; colourMode?: string; sides?: string; copies?: number } = {}
) {
  const doc = await uploadViaApi(slug, await makePdf(opts.pages ?? 3), opts.fileName ?? 'seed.pdf');
  const q = await jfetch(`${API}/api/v1/public/shops/${slug}/quotes`, {
    method: 'POST',
    json: {
      documentId: doc.documentId,
      printOptions: { paperSize: 'A4', colourMode: opts.colourMode ?? 'bw', sides: opts.sides ?? 'single', copies: opts.copies ?? 1, pageSelection: { mode: 'all' } }
    }
  });
  if (q.status !== 200) throw new Error(`quote ${q.status} ${JSON.stringify(q.body)}`);
  const o = await jfetch(`${API}/api/v1/public/shops/${slug}/orders`, {
    method: 'POST',
    json: { quoteId: q.body.data.quoteId, clientRequestId: randomUUID(), ...(opts.name ? { customerDisplayNameOrReference: opts.name } : {}) }
  });
  if (o.status !== 200) throw new Error(`order ${o.status} ${JSON.stringify(o.body)}`);
  return o.body.data as { orderNumber: string; trackingToken: string; totalPaise: number };
}

/** Logs in through the UI and waits for the shell. */
export async function uiLogin(page: Page, email: string, loginPath = '/shop/login') {
  await page.goto(loginPath);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function newMobileContext(browser: Browser, vp = VIEWPORTS.mobile): Promise<BrowserContext> {
  return browser.newContext({ viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2, baseURL: WEB });
}

/** Reads the private e2e database (read-only helper for assertions). */
export function dbQuery(sql: string): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('docker', ['exec', 'print-codex-postgres-1', 'psql', '-U', 'printout', '-d', 'printout_e2e', '-At', '-c', sql], { encoding: 'utf8' }).trim();
}
