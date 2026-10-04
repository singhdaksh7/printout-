import { useCallback, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { describeError } from '../lib/shop-api';
import { Banner, Skeleton } from '../shop/components';

export const MANUAL_NOTE = 'Commercial details are recorded manually. There is no billing automation: nothing is charged or renewed automatically.';

export function adminError(e: unknown): string {
  if (e instanceof ApiError && e.status === 403 && e.code !== 'CSRF_INVALID') return 'Access denied: your account is not allowed to do this (platform admin only).';
  return describeError(e);
}

export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: DependencyList) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ ...s, error: undefined, loading: true }));
    fnRef.current(ac.signal)
      .then((data) => { if (!ac.signal.aborted) setState({ data, loading: false }); })
      .catch((error) => { if (!ac.signal.aborted && !(error instanceof DOMException)) setState({ error, loading: false }); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <Banner kind="error" {...(onRetry ? { onRetry } : {})}>{adminError(error)}</Banner>;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <Skeleton lines={4} label={label} />;
}

/** Accumulating cursor pagination: first page via `fetchPage(undefined)`, then "Load more". Resets when deps change. */
export function useCursorList<T>(fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<{ items: T[]; nextCursor?: string | undefined }>, deps: DependencyList) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>();
  const [moreError, setMoreError] = useState<unknown>();
  const [n, setN] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true); setError(undefined); setMoreError(undefined);
    fetchRef.current(undefined, ac.signal)
      .then((p) => { if (ac.signal.aborted) return; setItems(p.items); setNext(p.nextCursor); setLoading(false); })
      .catch((e) => { if (ac.signal.aborted || e instanceof DOMException) return; setError(e); setItems([]); setNext(undefined); setLoading(false); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const loadMore = useCallback(async () => {
    if (!next || more) return;
    setMore(true); setMoreError(undefined);
    try {
      const p = await fetchRef.current(next, new AbortController().signal);
      setItems((x) => [...x, ...p.items]);
      setNext(p.nextCursor);
    } catch (e) { setMoreError(e); }
    setMore(false);
  }, [next, more]);
  return { items, hasMore: !!next, loading, more, error, moreError, loadMore, reload: useCallback(() => setN((x) => x + 1), []) };
}

export function LoadMore({ hasMore, more, onClick, error }: { hasMore: boolean; more: boolean; onClick: () => void; error?: unknown }) {
  return (
    <div className="sh-center" style={{ flexDirection: 'column', gap: '.5rem' }}>
      {error != null && <LoadError error={error} />}
      {hasMore ? <button className="sh-btn" onClick={onClick} disabled={more}>{more ? 'Loading…' : 'Load more'}</button> : <span className="sh-muted">End of list</span>}
    </div>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string | null | undefined; hint?: string; children: ReactNode }) {
  return (
    <label className="sh-field">
      <span>{label}</span>
      {children}
      {hint && !error && <span className="sh-muted" style={{ fontWeight: 400 }}>{hint}</span>}
      {error && <span className="sh-field-error" role="alert">{error}</span>}
    </label>
  );
}

export function ShopStatusChip({ status }: { status: string }) {
  const cls = status === 'ACTIVE' ? 'sh-chip-printed' : status === 'SUSPENDED' ? 'sh-chip-warn' : 'sh-chip-cancelled';
  return <span className={`sh-chip ${cls}`}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>;
}
