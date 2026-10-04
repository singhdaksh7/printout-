import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

// ---- one shared 1s ticker for every countdown / "x min ago" label (no per-card timers) -------------
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer) timer = setInterval(() => listeners.forEach((f) => f()), 1000);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}
/** Re-renders only when the primitive result of `compute` changes. */
export function useTick<T extends string | number | boolean | null>(compute: () => T): T {
  return useSyncExternalStore(subscribe, compute, compute);
}

export function ageLabel(iso: string, now = Date.now()): string {
  const s = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s)) return '';
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Calls `refresh` on an interval, on tab focus/visibility, and when the browser comes back online. */
export function useAutoRefresh(refresh: () => void, intervalMs = 45_000, enabled = true) {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    const run = () => { if (document.visibilityState !== 'hidden') ref.current(); };
    const id = setInterval(run, intervalMs);
    document.addEventListener('visibilitychange', run);
    window.addEventListener('focus', run);
    window.addEventListener('online', run);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('focus', run);
      window.removeEventListener('online', run);
    };
  }, [intervalMs, enabled]);
}

/** Debounced callback with cleanup. */
export function useDebounced(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return useCallback(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => { t.current = null; ref.current(); }, ms);
  }, [ms]);
}

export function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
