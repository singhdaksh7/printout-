import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { getTrackedOrder, isAbort, type OrderStatus, type TrackedOrder } from '../lib/customer-api';

export const TERMINAL: OrderStatus[] = ['COLLECTED', 'CANCELLED', 'EXPIRED'];
export const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60000;

export type OrderState = { phase: 'loading' } | { phase: 'missing' } | { phase: 'ready'; order: TrackedOrder; failing: boolean } | { phase: 'error' };

/** Polls the tracking endpoint: ~5s while active, paused when the tab is hidden, exponential back-off on errors,
 *  stops at COLLECTED/CANCELLED/EXPIRED. Also keeps a server clock skew so countdowns follow server time. */
export function useOrder(token: string) {
  const [state, setState] = useState<OrderState>({ phase: 'loading' });
  const skew = useRef(0);
  const once = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false, done = false, failures = 0;
    let timer: number | undefined;
    let ctl: AbortController | undefined;
    setState({ phase: 'loading' });

    const fetchNow = async (): Promise<boolean> => {
      ctl?.abort();
      const c = (ctl = new AbortController());
      try {
        const order = await getTrackedOrder(token, c.signal);
        if (stopped) return false;
        if (order.serverTime) { const t = Date.parse(order.serverTime); if (Number.isFinite(t)) skew.current = t - Date.now(); }
        failures = 0;
        setState({ phase: 'ready', order, failing: false });
        if (TERMINAL.includes(order.status)) done = true;
        return true;
      } catch (e) {
        if (stopped || isAbort(e)) return false;
        if (e instanceof ApiError && (e.status === 404 || e.code === 'NOT_FOUND' || e.code === 'ORDER_NOT_FOUND')) { done = true; setState({ phase: 'missing' }); return false; }
        failures++;
        setState((s) => (s.phase === 'ready' ? { ...s, failing: true } : { phase: 'error' }));
        return false;
      }
    };

    const loop = async () => {
      if (stopped || done) return;
      if (document.hidden) return; // resumed by the visibilitychange handler
      await fetchNow();
      if (stopped || done) return;
      const delay = failures ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures) : POLL_MS;
      timer = window.setTimeout(loop, delay);
    };

    const onVisible = () => { if (!document.hidden && !done && !stopped) { clearTimeout(timer); void loop(); } };
    document.addEventListener('visibilitychange', onVisible);
    once.current = () => { void fetchNow(); };
    void loop();
    return () => { stopped = true; clearTimeout(timer); ctl?.abort(); document.removeEventListener('visibilitychange', onVisible); };
  }, [token]);

  const refetch = useCallback(() => once.current(), []);
  return { state, skew, refetch };
}

/** Ticks once a second while `active`, returning server-corrected "now". */
export function useServerNow(skew: { current: number }, active: boolean) {
  const [now, setNow] = useState(() => Date.now() + skew.current);
  useEffect(() => {
    setNow(Date.now() + skew.current);
    if (!active) return;
    const id = setInterval(() => setNow(Date.now() + skew.current), 1000);
    return () => clearInterval(id);
  }, [active, skew]);
  return now;
}
