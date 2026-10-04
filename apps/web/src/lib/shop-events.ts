// Testable SSE client. EventSource is injectable; reconnect with exponential backoff when the browser gives up.
export const SHOP_EVENT_NAMES = ['order.created', 'order.updated', 'order.statusChanged', 'document.deletionScheduled', 'document.deleted'] as const;
export type ShopEventName = (typeof SHOP_EVENT_NAMES)[number];
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';
export interface ShopEvent { type: string; data: Record<string, unknown> | null; id: string }

export interface ESLike {
  readyState: number;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  addEventListener(type: string, l: (e: MessageEvent) => void): void;
  close(): void;
}
export type ESCtor = new (url: string, init?: { withCredentials?: boolean }) => ESLike;

export interface EventClientOptions {
  url?: string;
  EventSourceImpl?: ESCtor | undefined;
  onEvent: (e: ShopEvent) => void;
  onState: (s: ConnectionState) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isOnline?: () => boolean;
}
export interface EventClient { close(): void; reconnectNow(): void }

const CLOSED = 2;

export function createEventSourceClient(opts: EventClientOptions): EventClient {
  const url = opts.url ?? '/api/v1/shop/events';
  const Impl = opts.EventSourceImpl ?? (globalThis as { EventSource?: ESCtor }).EventSource;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const online = opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  let es: ESLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let closed = false;
  let state: ConnectionState = 'connecting';
  const seen: string[] = [];
  const setState = (s: ConnectionState) => { if (s !== state) { state = s; opts.onState(s); } };

  function teardown() {
    if (es) { es.onopen = null; es.onerror = null; es.close(); es = null; }
  }
  function schedule() {
    if (closed || timer) return;
    const delay = Math.min(max, base * 2 ** attempts);
    attempts += 1;
    timer = setTimeout(() => { timer = null; connect(); }, delay);
  }
  function connect() {
    if (closed) return;
    teardown();
    if (!Impl) { setState('offline'); return; }
    if (!online()) { setState('offline'); return; }
    setState(attempts === 0 ? 'connecting' : 'reconnecting');
    const source = new Impl(url, { withCredentials: true });
    es = source;
    source.onopen = () => { attempts = 0; setState('live'); };
    source.onerror = () => {
      if (closed || es !== source) return;
      if (!online()) { setState('offline'); }
      else setState('reconnecting');
      if (source.readyState === CLOSED) { teardown(); schedule(); } // browser gave up: we retry ourselves
    };
    for (const name of SHOP_EVENT_NAMES) {
      source.addEventListener(name, (m) => {
        const id = (m as MessageEvent).lastEventId || '';
        if (id) {
          if (seen.includes(id)) return;
          seen.push(id);
          if (seen.length > 100) seen.shift();
        }
        let data: Record<string, unknown> | null = null;
        try { data = JSON.parse(String(m.data)) as Record<string, unknown>; } catch { data = null; }
        opts.onEvent({ type: name, data, id });
      });
    }
  }
  const onOnline = () => { if (!closed) { if (timer) { clearTimeout(timer); timer = null; } attempts = 0; connect(); } };
  const onOffline = () => { if (!closed) setState('offline'); };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }
  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      teardown();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
    },
    reconnectNow() { if (timer) { clearTimeout(timer); timer = null; } attempts = 0; connect(); }
  };
}
