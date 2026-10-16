import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { ApiError } from '../lib/api';
import { describeError } from '../lib/shop-api';
import { Banner, Button, LoadMore as UiLoadMore, Skeleton } from '../ui';

export { ShopStatusChip } from '../ui';

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
  return (
    <Banner tone="err" actions={onRetry ? <Button size="sm" variant="dark" onClick={onRetry}>Retry</Button> : undefined}>
      {adminError(error)}
    </Banner>
  );
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

/** Admin wrapper over the shared LoadMore: same props as before, error rendered as a Banner. */
export function LoadMore({ hasMore, more, onClick, error }: { hasMore: boolean; more: boolean; onClick: () => void; error?: unknown }) {
  return <UiLoadMore hasMore={hasMore} loading={more} onClick={onClick} error={error != null ? <LoadError error={error} /> : undefined} />;
}
