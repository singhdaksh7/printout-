#!/usr/bin/env node
// Printout production smoke test. Dependency-free (Node >= 20). See docs/PROD_SMOKE.md.
//
//   BASE_URL=https://printout.example.com node deploy/smoke.mjs                 # public + security checks only
//   BASE_URL=... SHOP_SLUG=smoke-shop SHOP_EMAIL=... SHOP_PASSWORD=... \
//     ADMIN_EMAIL=... ADMIN_PASSWORD=... node deploy/smoke.mjs                  # + shop/admin/SSE read checks
//   SMOKE_WRITE=1 ... node deploy/smoke.mjs                                     # + ONE tiny test order (see warning)
//
// Default mode is READ-ONLY (logins create sessions, which is the only state change; they are logged out again).
// SMOKE_WRITE=1 creates a real order + uploads a tiny generated PDF to the shop's private bucket, then prints it
// through the normal lifecycle so the 30-minute retention clock is exercised. Only use a shop reserved for smoke tests.
//
// Optional env: SMOKE_INSECURE=1 (accept self-signed TLS, e.g. Caddy internal CA locally), SSE_WAIT_SECONDS (default 8),
//               SKIP_HSTS=1 (plain-http local stacks), EXPECT_RETENTION_MINUTES (default: value from the public shop API).
// Exit code 0 = all executed checks passed (skipped ones are listed), 1 otherwise.
import { randomUUID } from 'node:crypto';

const env = process.env;
const BASE = (env.BASE_URL ?? '').replace(/\/+$/, '');
if (!BASE) {
  console.error('BASE_URL is required, e.g. BASE_URL=https://printout.example.com');
  process.exit(2);
}
if (env.SMOKE_INSECURE === '1') env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const API = `${BASE}/api/v1`;
const WRITE = env.SMOKE_WRITE === '1';
const SSE_WAIT_MS = Number(env.SSE_WAIT_SECONDS ?? 8) * 1000;
const isHttps = BASE.startsWith('https://');

const results = [];
const record = (status, name, detail = '') => {
  results.push({ status, name });
  const tag = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? `  - ${detail}` : ''}`);
};
async function check(name, fn) {
  try {
    const detail = await fn();
    record('pass', name, typeof detail === 'string' ? detail : '');
    return true;
  } catch (e) {
    record('fail', name, e instanceof Error ? e.message : String(e));
    return false;
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const skip = (name, why) => record('skip', name, why);

const req = (url, init = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...init });
const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
};

class Session {
  constructor(label) {
    this.label = label;
    this.cookie = '';
    this.csrf = '';
  }
  async login(email, password) {
    const res = await req(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const body = await json(res);
    assert(res.status === 200, `login HTTP ${res.status} ${body?.error?.code ?? ''}`);
    this.cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    assert(this.cookie.includes('printout_session='), 'no session cookie in login response');
    this.csrf = body.data.csrfToken;
    this.user = body.data.user;
    return body.data;
  }
  headers(extra = {}, mutating = false) {
    return { cookie: this.cookie, ...(mutating ? { 'x-csrf-token': this.csrf, 'content-type': 'application/json' } : {}), ...extra };
  }
  async get(path) {
    const res = await req(`${API}${path}`, { headers: this.headers() });
    return { res, body: await json(res) };
  }
  async post(path, payload) {
    const res = await req(`${API}${path}`, { method: 'POST', headers: this.headers({}, true), body: JSON.stringify(payload ?? {}) });
    return { res, body: await json(res) };
  }
  async logout() {
    await req(`${API}/auth/logout`, { method: 'POST', headers: this.headers({}, true), body: '{}' }).catch(() => undefined);
  }
}

/** Smallest valid one-page A4 PDF with a text line (hand-built xref, no dependencies). */
function tinyPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const stream = 'BT /F1 18 Tf 72 760 Td (Printout smoke test - safe to discard) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

console.log(`Printout smoke  BASE_URL=${BASE}  mode=${WRITE ? 'READ+WRITE (SMOKE_WRITE=1)' : 'read-only'}`);
if (WRITE) {
  console.log('!!! SMOKE_WRITE=1: this creates ONE real test order and uploads a tiny PDF to the shop storage.');
  console.log('!!! Only run it against a shop reserved for smoke tests (SHOP_SLUG), never a customer shop.');
}

// ---------- 1. public edge ----------
let shopPublic;
await check('homepage 200 (HTML)', async () => {
  const res = await req(`${BASE}/`);
  assert(res.status === 200, `HTTP ${res.status}`);
  assert((res.headers.get('content-type') ?? '').includes('text/html'), `content-type ${res.headers.get('content-type')}`);
});
await check('manifest.webmanifest 200', async () => {
  const res = await req(`${BASE}/manifest.webmanifest`);
  assert(res.status === 200, `HTTP ${res.status}`);
  const m = await json(res);
  assert(m.name || m.short_name, 'manifest has no name');
});
await check('service worker is not cached (sw.js no-cache)', async () => {
  const res = await req(`${BASE}/sw.js`);
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(/no-cache|no-store/i.test(res.headers.get('cache-control') ?? ''), `cache-control: ${res.headers.get('cache-control')}`);
});
await check('/health 200 (liveness)', async () => {
  const res = await req(`${BASE}/health`);
  assert(res.status === 200, `HTTP ${res.status}`);
  assert((await json(res)).data.status === 'ok', 'status != ok');
});
await check('/ready 200 (DB reachable)', async () => {
  const res = await req(`${BASE}/ready`);
  assert(res.status === 200, `HTTP ${res.status}`);
  assert((await json(res)).data.status === 'ready', 'status != ready');
});
await check('security headers on homepage', async () => {
  const res = await req(`${BASE}/`);
  const h = (n) => res.headers.get(n) ?? '';
  assert(/nosniff/i.test(h('x-content-type-options')), 'missing X-Content-Type-Options: nosniff');
  assert(h('content-security-policy').includes("default-src 'self'"), 'missing/weak Content-Security-Policy');
  assert(h('referrer-policy') !== '', 'missing Referrer-Policy');
  assert(!/\bcaddy\b/i.test(h('server')), 'Server header leaks proxy');
  if (isHttps && env.SKIP_HSTS !== '1') assert(/max-age=\d{7,}/.test(h('strict-transport-security')), 'missing/short HSTS');
});
if (isHttps) {
  await check('HTTP redirects to HTTPS', async () => {
    const httpUrl = (env.HTTP_BASE_URL ?? BASE.replace(/^https:/, 'http:')) + '/';
    const res = await req(httpUrl);
    assert([301, 302, 307, 308].includes(res.status), `HTTP ${res.status} (expected redirect)`);
    assert((res.headers.get('location') ?? '').startsWith('https://'), `Location: ${res.headers.get('location')}`);
  });
} else skip('HTTP to HTTPS redirect', 'BASE_URL is not https');
await check('unknown API route is 404 JSON (no stack)', async () => {
  const res = await req(`${API}/definitely-not-a-route`);
  assert(res.status === 404, `HTTP ${res.status}`);
  const text = await res.text();
  assert(!/node_modules|at .*\.js:\d+/.test(text), 'response leaks internals');
});
await check('private paths are not served (/.env, /.data, /deploy/)', async () => {
  for (const p of ['/.env', '/.data/uploads', '/deploy/.env.production', '/uploads/']) {
    const res = await req(`${BASE}${p}`);
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    assert(!/POSTGRES_PASSWORD|SESSION_SECRET|S3_SECRET/.test(text), `${p} exposes secrets`);
    // The SPA fallback may answer 200 with index.html; anything else must not be a file listing or env file.
    assert(res.status !== 200 || type.includes('text/html'), `${p} -> ${res.status} ${type}`);
  }
});

const SLUG = env.SHOP_SLUG;
if (SLUG) {
  await check(`public shop page API (${SLUG})`, async () => {
    const res = await req(`${API}/public/shops/${encodeURIComponent(SLUG)}`);
    assert(res.status === 200, `HTTP ${res.status}`);
    shopPublic = (await json(res)).data;
    assert(shopPublic.slug === SLUG, 'slug mismatch');
    assert(!('ownerEmail' in shopPublic) && !('id' in shopPublic), 'shop payload leaks internal fields');
    return `status=${shopPublic.status ?? 'ACTIVE'} acceptsOrders=${shopPublic.acceptsOrders} retentionMinutes=${shopPublic.retentionMinutes}`;
  });
} else skip('public shop page API', 'SHOP_SLUG not set');

// ---------- 2. shop session (read) ----------
const shop = new Session('shop');
let shopOk = false;
if (env.SHOP_EMAIL && env.SHOP_PASSWORD) {
  shopOk = await check('shop login + session', async () => {
    const data = await shop.login(env.SHOP_EMAIL, env.SHOP_PASSWORD);
    assert(data.shop, 'user has no shop');
    if (SLUG) assert(data.shop.slug === SLUG, `SHOP_EMAIL belongs to shop ${data.shop.slug}, not SHOP_SLUG ${SLUG}`);
    const s = await shop.get('/auth/session');
    assert(s.res.status === 200, `GET /auth/session HTTP ${s.res.status}`);
    return `shop=${data.shop.slug}`;
  });
  if (shopOk) {
    await check('shop queue read (GET /shop/orders)', async () => {
      const { res, body } = await shop.get('/shop/orders?active=1&limit=5');
      assert(res.status === 200, `HTTP ${res.status}`);
      assert(Array.isArray(body.data.items), 'no items array');
      return `${body.data.items.length} active order(s)`;
    });
    await check('shop mutation without CSRF is rejected', async () => {
      const res = await req(`${API}/shop/pricing-rules`, { method: 'POST', headers: { cookie: shop.cookie, 'content-type': 'application/json' }, body: '{}' });
      assert(res.status === 403, `HTTP ${res.status} (expected 403 CSRF_INVALID)`);
    });
    await check(`SSE /shop/events connects and streams (${SSE_WAIT_MS / 1000}s)`, async () => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), SSE_WAIT_MS);
      const t0 = Date.now();
      try {
        const res = await fetch(`${API}/shop/events`, { headers: { cookie: shop.cookie, accept: 'text/event-stream' }, signal: ac.signal });
        assert(res.status === 200, `HTTP ${res.status}`);
        const type = res.headers.get('content-type') ?? '';
        assert(type.includes('text/event-stream'), `content-type ${type}`);
        assert(!res.headers.get('content-encoding'), `SSE is compressed (${res.headers.get('content-encoding')}); proxies would buffer it`);
        const reader = res.body.getReader();
        const first = await reader.read();
        const text = new TextDecoder().decode(first.value ?? new Uint8Array());
        assert(/retry:|^:|event:/m.test(text), `unexpected first chunk: ${JSON.stringify(text.slice(0, 60))}`);
        ac.abort();
        return `first chunk after ${Date.now() - t0} ms: ${JSON.stringify(text.trim().slice(0, 30))}`;
      } finally {
        clearTimeout(t);
      }
    });
  }
} else skip('shop login / queue / SSE', 'SHOP_EMAIL / SHOP_PASSWORD not set');

// ---------- 3. admin (read) ----------
const admin = new Session('admin');
if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  const ok = await check('admin login + session', async () => {
    const data = await admin.login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
    assert(data.user.role === 'PLATFORM_ADMIN', `role ${data.user.role}`);
  });
  if (ok) {
    await check('admin dashboard read', async () => {
      const { res, body } = await admin.get('/admin/dashboard');
      assert(res.status === 200, `HTTP ${res.status}`);
      assert(body.data && typeof body.data === 'object', 'no data');
    });
    await check('admin cannot reach shop endpoints (role isolation)', async () => {
      const { res } = await admin.get('/shop/orders');
      assert([401, 403, 404].includes(res.status), `HTTP ${res.status}`);
    });
  }
} else skip('admin login / dashboard', 'ADMIN_EMAIL / ADMIN_PASSWORD not set');

// ---------- 4. WRITE mode: one tiny order through the full lifecycle ----------
if (WRITE) {
  if (!(SLUG && shopOk)) {
    record('fail', 'SMOKE_WRITE prerequisites', 'needs SHOP_SLUG + SHOP_EMAIL + SHOP_PASSWORD (a smoke-test shop)');
  } else {
    const state = {};
    const pdf = tinyPdf();
    const step = async (name, fn) => {
      if (state.broken) return skip(name, 'earlier write step failed');
      if (!(await check(name, fn))) state.broken = true;
    };
    await step('write: upload initiate', async () => {
      const res = await req(`${API}/public/shops/${SLUG}/uploads/initiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'printout-smoke.pdf', byteSize: pdf.length, declaredMimeType: 'application/pdf' })
      });
      const body = await json(res);
      assert(res.status === 200, `HTTP ${res.status} ${body?.error?.code ?? ''}`);
      state.upload = body.data;
    });
    await step('write: upload PUT (raw bytes)', async () => {
      const u = state.upload.uploadUrl.startsWith('http') ? state.upload.uploadUrl : `${BASE}${state.upload.uploadUrl}`;
      const res = await req(u, { method: 'PUT', headers: { ...state.upload.requiredHeaders }, body: pdf });
      assert(res.status === 200, `HTTP ${res.status} ${(await res.text()).slice(0, 100)}`);
    });
    await step('write: upload complete', async () => {
      const res = await req(`${API}/public/shops/${SLUG}/uploads/${state.upload.uploadId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await json(res);
      assert(res.status === 200, `HTTP ${res.status} ${body?.error?.code ?? ''}`);
      assert(body.data.documentStatus === 'AVAILABLE' && body.data.pageCount === 1, `unexpected ${JSON.stringify(body.data)}`);
      state.documentId = body.data.documentId;
    });
    await step('write: quote', async () => {
      const res = await req(`${API}/public/shops/${SLUG}/quotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId: state.documentId, printOptions: { paperSize: 'A4', colourMode: 'bw', sides: 'single', copies: 1, pageSelection: { mode: 'all' } } })
      });
      const body = await json(res);
      assert(res.status === 200, `HTTP ${res.status} ${body?.error?.code ?? ''} (does the smoke shop have an active B&W single-sided pricing rule?)`);
      state.quoteId = body.data.quoteId;
      return `total ${body.data.totalPaise} paise`;
    });
    await step('write: create order', async () => {
      const res = await req(`${API}/public/shops/${SLUG}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quoteId: state.quoteId, customerDisplayNameOrReference: 'SMOKE TEST', clientRequestId: randomUUID() })
      });
      const body = await json(res);
      assert(res.status === 200 || res.status === 201, `HTTP ${res.status} ${body?.error?.code ?? ''}`);
      state.order = body.data;
      return state.order.orderNumber;
    });
    await step('write: shop finds the order in its queue', async () => {
      const { body } = await shop.get('/shop/orders?limit=20');
      const found = body.data.items.find((o) => o.orderNumber === state.order.orderNumber);
      assert(found, 'order not in queue');
      state.orderId = found.id;
    });
    for (const toStatus of ['ACCEPTED', 'PRINTING']) {
      await step(`write: transition to ${toStatus}`, async () => {
        const { res, body } = await shop.post(`/shop/orders/${state.orderId}/transitions`, { toStatus, clientRequestId: randomUUID() });
        assert(res.status === 200, `HTTP ${res.status} ${body?.error?.code ?? ''}`);
      });
    }
    await step('write: document-access URL fetches a real PDF', async () => {
      const { res, body } = await shop.post(`/shop/orders/${state.orderId}/document-access`, {});
      assert(res.status === 200, `HTTP ${res.status} ${body?.error?.code ?? ''}`);
      const url = body.data.url.startsWith('http') ? body.data.url : `${BASE}${body.data.url}`;
      const f = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      assert(f.status === 200, `document fetch HTTP ${f.status}`);
      const bytes = Buffer.from(await f.arrayBuffer());
      assert(bytes.subarray(0, 5).toString() === '%PDF-', 'fetched object is not a PDF');
      assert(bytes.equals(pdf), 'fetched PDF differs from the uploaded bytes');
      return `${bytes.length} bytes, identical to upload`;
    });
    await step('write: print confirmation sets retention clock', async () => {
      const { res, body } = await shop.post(`/shop/orders/${state.orderId}/print-confirmation`, { clientRequestId: randomUUID() });
      assert(res.status === 200, `HTTP ${res.status} ${body?.error?.code ?? ''}`);
      const d = body.data.document;
      const minutes = (new Date(d.deleteAfter) - new Date(d.printedAt)) / 60000;
      const expected = Number(env.EXPECT_RETENTION_MINUTES ?? shopPublic?.retentionMinutes ?? 30);
      assert(d.status === 'PRINTED_RETENTION', `document status ${d.status}`);
      assert(minutes === expected, `deleteAfter - printedAt = ${minutes} min, expected ${expected}`);
      return `deleteAfter - printedAt = ${minutes} min`;
    });
    await step('write: customer tracking shows deleteAfter', async () => {
      const res = await req(`${API}/public/orders/${state.order.trackingToken}`);
      const body = await json(res);
      assert(res.status === 200 && body.data.status === 'PRINTED', `HTTP ${res.status} status ${body?.data?.status}`);
      assert(body.data.document.deleteAfter, 'no deleteAfter on tracking page');
    });
    if (state.orderId) {
      console.log(`NOTE  smoke order ${state.order?.orderNumber} left in PRINTED state; its document is deleted by the worker ~${shopPublic?.retentionMinutes ?? 30} min after printing.`);
      console.log('NOTE  re-check in ~35 minutes that the document is DELETED (shop order detail) to prove the worker + R2 deletion.');
    }
  }
} else {
  skip('write-mode order lifecycle', 'SMOKE_WRITE not set (default read-only)');
}

await shop.logout();
await admin.logout();

const failed = results.filter((r) => r.status === 'fail').length;
const passed = results.filter((r) => r.status === 'pass').length;
const skipped = results.filter((r) => r.status === 'skip').length;
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
