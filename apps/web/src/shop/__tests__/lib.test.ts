import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventSourceClient, type ConnectionState } from '../../lib/shop-events';
import { paiseToRupeesInput, parseRupeesToPaise } from '../../lib/shop-money';
import { shopRequest, setUnauthorizedHandler } from '../../lib/shop-api';
import { setCsrfToken } from '../../lib/api';
import { FakeES } from './helpers';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); FakeES.reset(); setUnauthorizedHandler(null); });

describe('money', () => {
  it.each([['2', 200], ['2.5', 250], ['2.50', 250], ['0.05', 5], ['₹12.05', 1205], [' 1000 ', 100000]])('parses %s', (i, p) => {
    expect(parseRupeesToPaise(i)).toEqual({ ok: true, paise: p });
  });
  it.each(['', 'abc', '-1', '0', '0.00', '1.234', '1000.01', '1e3', 'NaN', 'Infinity'])('rejects %j', (i) => {
    expect(parseRupeesToPaise(i).ok).toBe(false);
  });
  it('formats paise', () => { expect(paiseToRupeesInput(5)).toBe('0.05'); expect(paiseToRupeesInput(1205)).toBe('12.05'); });
});

describe('createEventSourceClient', () => {
  const make = (extra: Partial<Parameters<typeof createEventSourceClient>[0]> = {}) => {
    const states: ConnectionState[] = []; const events: unknown[] = [];
    const client = createEventSourceClient({ EventSourceImpl: FakeES, onEvent: (e) => events.push(e), onState: (s) => states.push(s), baseDelayMs: 100, maxDelayMs: 400, ...extra });
    return { client, states, events };
  };

  it('connects with credentials, dispatches parsed events and dedupes by event id', () => {
    const { states, events } = make();
    const es = FakeES.instances[0]!;
    expect(es.init).toEqual({ withCredentials: true });
    es.open_();
    es.emit('order.created', { id: 'a' }, '1');
    es.emit('order.created', { id: 'a' }, '1');
    es.emit('document.deleted', { id: 'a' }, '2');
    expect(states).toEqual(['live']);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'order.created', data: { id: 'a' } });
  });

  it('reconnects with exponential backoff when the browser gives up (CLOSED)', () => {
    vi.useFakeTimers();
    const { states, client } = make();
    FakeES.instances[0]!.fail(true);
    expect(states.at(-1)).toBe('reconnecting');
    expect(FakeES.instances).toHaveLength(1);
    vi.advanceTimersByTime(99); expect(FakeES.instances).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(FakeES.instances).toHaveLength(2);
    FakeES.instances[1]!.fail(true);
    vi.advanceTimersByTime(199); expect(FakeES.instances).toHaveLength(2);
    vi.advanceTimersByTime(1); expect(FakeES.instances).toHaveLength(3);
    FakeES.instances[2]!.fail(true); vi.advanceTimersByTime(400);
    FakeES.instances[3]!.fail(true); vi.advanceTimersByTime(399); expect(FakeES.instances).toHaveLength(4); // capped at 400
    vi.advanceTimersByTime(1); expect(FakeES.instances).toHaveLength(5);
    FakeES.instances[4]!.open_();
    expect(states.at(-1)).toBe('live');
    client.close();
    expect(FakeES.open).toHaveLength(0);
  });

  it('lets the browser auto-retry on transient errors without opening a second connection', () => {
    const { states } = make();
    FakeES.instances[0]!.open_();
    FakeES.instances[0]!.fail(false);
    expect(states.at(-1)).toBe('reconnecting');
    expect(FakeES.instances).toHaveLength(1);
  });

  it('close() stops reconnecting and removes listeners', () => {
    vi.useFakeTimers();
    const { client } = make();
    FakeES.instances[0]!.fail(true);
    client.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeES.instances).toHaveLength(1);
  });

  it('reports offline when the browser is offline', () => {
    const { states } = make({ isOnline: () => false });
    expect(states.at(-1)).toBe('offline');
    expect(FakeES.instances).toHaveLength(0);
  });
});

describe('shopRequest', () => {
  it('on 403 CSRF_INVALID refreshes the session once and retries GET only', async () => {
    let csrfOk = false;
    const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url); const m = init?.method ?? 'GET';
      if (u.endsWith('/auth/session')) { csrfOk = true; return new Response(JSON.stringify({ data: { csrfToken: 'fresh', user: {}, shop: {} } })); }
      if (m === 'GET' && u.endsWith('/x') && !csrfOk) return new Response(JSON.stringify({ error: { code: 'CSRF_INVALID', message: 'm', requestId: 'r' } }), { status: 403 });
      if (m === 'POST') return new Response(JSON.stringify({ error: { code: 'CSRF_INVALID', message: 'm', requestId: 'r' } }), { status: 403 });
      return new Response(JSON.stringify({ data: 'ok' }));
    });
    vi.stubGlobal('fetch', f);
    setCsrfToken('stale');
    expect(await shopRequest('/x')).toBe('ok');
    await expect(shopRequest('/x', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'CSRF_INVALID' });
    const posts = f.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(1); // never auto-retried
  });

  it('invokes the unauthorized handler on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'm', requestId: 'r' } }), { status: 401 })));
    const h = vi.fn(); setUnauthorizedHandler(h);
    await expect(shopRequest('/x')).rejects.toMatchObject({ status: 401 });
    expect(h).toHaveBeenCalledTimes(1);
  });
});
