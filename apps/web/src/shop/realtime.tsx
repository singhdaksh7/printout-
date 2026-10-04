import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createEventSourceClient, type ConnectionState, type ShopEvent } from '../lib/shop-events';

type Listener = (e: ShopEvent) => void;
interface RealtimeApi { state: ConnectionState; subscribe(l: Listener): () => void; reconnects: number }
const Ctx = createContext<RealtimeApi>({ state: 'offline', subscribe: () => () => {}, reconnects: 0 });
export const useRealtime = () => useContext(Ctx);

/** Owns the single SSE connection for the shop area. Closed on unmount (logout / session expiry). */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [reconnects, setReconnects] = useState(0);
  const listeners = useRef(new Set<Listener>());
  const prev = useRef<ConnectionState>('connecting');

  useEffect(() => {
    prev.current = 'connecting';
    const client = createEventSourceClient({
      onEvent: (e) => listeners.current.forEach((l) => l(e)),
      onState: (s) => {
        // coming back to live after a gap means we may have missed events: let pages refetch
        if (s === 'live' && (prev.current === 'reconnecting' || prev.current === 'offline')) setReconnects((n) => n + 1);
        prev.current = s;
        setState(s);
      }
    });
    return () => client.close();
  }, []);

  const subscribe = useCallback((l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l); }; }, []);
  const value = useMemo<RealtimeApi>(() => ({ state, reconnects, subscribe }), [state, reconnects, subscribe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Run `fn` on any realtime event (and after a reconnect). */
export function useRealtimeRefresh(fn: (e?: ShopEvent) => void) {
  const { subscribe, reconnects } = useRealtime();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    ref.current();
  }, [reconnects]);
}
