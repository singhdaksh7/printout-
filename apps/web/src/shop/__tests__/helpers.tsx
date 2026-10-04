import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import ShopRoutes from '../ShopRoutes';
import type { OrderSummary, SessionData } from '../../lib/shop-api';

export class FakeES {
  static instances: FakeES[] = [];
  static reset() { FakeES.instances = []; }
  static get open() { return FakeES.instances.filter((i) => !i.closed); }
  readyState = 0;
  closed = false;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string, public init?: { withCredentials?: boolean }) { FakeES.instances.push(this); }
  addEventListener(t: string, l: (e: MessageEvent) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]); }
  close() { this.closed = true; this.readyState = 2; }
  // test helpers
  open_() { this.readyState = 1; this.onopen?.(new Event('open')); }
  emit(type: string, data: unknown, id = String(Math.random())) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id });
    this.listeners.get(type)?.forEach((l) => l(ev));
  }
  fail(closedForGood = false) { this.readyState = closedForGood ? 2 : 0; this.onerror?.(new Event('error')); }
}

export const session = (over: Partial<SessionData> = {}): SessionData => ({
  user: { id: 'u1', displayName: 'Owner', role: 'SHOP_OWNER' },
  shop: { id: 's1', slug: 'central', displayName: 'Central Print' },
  csrfToken: 'csrf-1',
  ...over
});

export const order = (over: Partial<OrderSummary> = {}): OrderSummary => ({
  id: 'o1', orderNumber: 'CENT-1', status: 'NEW', totalPaise: 1250, createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  documentStatus: 'AVAILABLE', originalFilename: 'thesis-final.pdf', pageCount: 10, selectedPageCount: 4, colourMode: 'bw', sides: 'duplex',
  copies: 2, customerDisplayNameOrReference: 'Asha', deleteAfter: null, ...over
});

export type Handler = (req: { method: string; path: string; query: URLSearchParams; body: any }) => { status?: number; data?: unknown; error?: { code: string; message?: string } } | undefined;

export interface Calls { method: string; path: string; body: any; headers: Record<string, string> }
/** Installs a fetch mock. Handlers are checked in order; first non-undefined result wins. */
export function mockFetch(...handlers: Handler[]) {
  const calls: Calls[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace(/^\/api\/v1/, '');
    calls.push({ method, path, body, headers: (init?.headers ?? {}) as Record<string, string> });
    for (const h of handlers) {
      const r = h({ method, path, query: url.searchParams, body });
      if (!r) continue;
      if (r.error) return new Response(JSON.stringify({ error: { requestId: 'r', message: 'x', ...r.error } }), { status: r.status ?? 400 });
      if (r.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ data: r.data }), { status: r.status ?? 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'nf', requestId: 'r' } }), { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export const authedSession: Handler = ({ method, path }) => (method === 'GET' && path === '/auth/session' ? { data: session() } : undefined);
export const emptyList: Handler = ({ method, path }) => (method === 'GET' && path === '/shop/orders' ? { data: { items: [] } } : undefined);

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}{l.search}</div>; }

export function renderShop(path = '/shop', opts: { strict?: boolean } = {}) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/shop/*" element={<ShopRoutes />} />
        <Route path="/admin" element={<div>ADMIN AREA</div>} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
  return render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
}
