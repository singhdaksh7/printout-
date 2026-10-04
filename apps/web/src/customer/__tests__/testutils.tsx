import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import CustomerRoutes from '../CustomerRoutes';

export type Call = { method: string; path: string; body: any };
export type Reply = { status?: number; data?: unknown; error?: { code: string; message?: string } } | 'network';
type Handler = (call: Call) => Reply | Promise<Reply>;

/** Mocks global fetch. Keys are "METHOD /path-after-/api/v1" (exact) or RegExp-ish via prefix match with `*` suffix. */
export function mockApi(handlers: Record<string, Handler | Reply>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^.*\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, path: url, body };
    calls.push(call);
    const key = Object.keys(handlers).find((k) => {
      const [m, p] = k.split(' ') as [string, string];
      return m === method && (p.endsWith('*') ? url.startsWith(p.slice(0, -1)) : url === p);
    });
    if (!key) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'unmocked ' + method + ' ' + url } }), { status: 404 });
    const h = handlers[key]!;
    const reply = typeof h === 'function' ? await h(call) : h;
    if (reply === 'network') throw new TypeError('Failed to fetch');
    const status = reply.status ?? (reply.error ? 400 : 200);
    return new Response(JSON.stringify(reply.error ? { error: { requestId: 'r', message: 'm', ...reply.error } } : { data: reply.data }), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn, count: (m: string, p: string) => calls.filter((c) => c.method === m && (p.endsWith('*') ? c.path.startsWith(p.slice(0, -1)) : c.path === p)).length };
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export class MockXHR {
  static instances: MockXHR[] = [];
  method = ''; url = ''; headers: Record<string, string> = {}; sent: unknown = null; aborted = false;
  status = 0; responseText = '';
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
  constructor() { MockXHR.instances.push(this); }
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  send(b: unknown) { this.sent = b; }
  abort() { this.aborted = true; this.onabort?.(); }
  progress(loaded: number, total: number) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }); }
  respond(status: number, body: unknown = '') { this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body); this.onload?.(); }
  fail() { this.onerror?.(); }
  static get last() { return MockXHR.instances[MockXHR.instances.length - 1]!; }
  static install() { MockXHR.instances = []; vi.stubGlobal('XMLHttpRequest', MockXHR); }
}

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}</div>; }

export function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/p/*" element={<CustomerRoutes />} />
        <Route path="/t/*" element={<CustomerRoutes />} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
}

export const shopOk = { slug: 'demo-shop', displayName: 'Demo Copy Centre', address: '12 Main Road', acceptsOrders: true, retentionMinutes: 30 };
export const initiateOk = { uploadId: 'up-12345678', uploadUrl: '/api/v1/public/uploads/up-12345678/content?token=t', requiredHeaders: { 'content-type': 'application/pdf' }, expiresAt: '2030-01-01T00:00:00Z', limits: { acceptedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 52428800, maxPdfPages: 200, imagePageCount: 1 } };
export const completeOk = { documentId: 'doc-12345678', detectedMimeType: 'application/pdf', byteSize: 2048, pageCount: 12, documentStatus: 'AVAILABLE', expiresAt: '2030-01-02T00:00:00Z' };
export const quoteOk = { quoteId: 'q1', selectedPageCount: 12, sheetsPerCopy: 12, totalSheets: 12, unitPricePaise: 200, totalPaise: 2400, currency: 'INR', expiresAt: new Date(Date.now() + 600000).toISOString() };

export const pdf = (name = 'notes.pdf', size = 2048) => {
  const f = new File(['x'.repeat(10)], name, { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
