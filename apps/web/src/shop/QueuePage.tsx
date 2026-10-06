import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatCountdown, formatPaise } from '../lib/format';
import { listOrders, describeError, type OrderSummary } from '../lib/shop-api';
import { Banner, pageSelectionText, Skeleton, StatusChip } from './components';
import { ageLabel, safeStorage, useAutoRefresh, useDebounced, useTick } from './hooks';
import { printNowAndOpen, saveFileToDevice, SAVE_FILE_NOTE } from './print-actions';
import { useRealtimeRefresh } from './realtime';

export interface Tab { key: string; label: string; query: { status?: string; active?: boolean; print?: 'pending' | 'initiated' } }
export const TABS: Tab[] = [
  // New: customer requests nobody has pressed Print on yet.
  { key: 'new', label: 'New', query: { print: 'pending', status: 'NEW,ACCEPTED,PRINTING' } },
  // Recent: Print was pressed; reprint stays available until the file is deleted.
  { key: 'recent', label: 'Recent', query: { print: 'initiated' } },
  { key: 'closed', label: 'Cancelled / expired', query: { status: 'CANCELLED,EXPIRED' } }
];
const MAX_REFRESH_PAGES = 5;

/** Lists orders for one filter (newest first, API cursor pagination). */
function useQueue(tab: Tab) {
  const [items, setItems] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [freshTick, setFreshTick] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const pages = useRef(1);
  const seen = useRef<Set<string> | null>(null);
  const gen = useRef(0);
  const activeKey = useRef(tab.key);
  activeKey.current = tab.key;
  const newestFresh = useRef(0);
  const key = tab.key;

  const refresh = useCallback(async (initial = false) => {
    const my = ++gen.current;
    if (initial) setLoading(true);
    try {
      // Re-fetch as many pages as the user has loaded so far, so "Load more" results stay current.
      const all: OrderSummary[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < (initial ? 1 : pages.current); i++) {
        const page = await listOrders({ ...tab.query, cursor });
        all.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      if (my !== gen.current) return;
      const merged = [...new Map(all.map((o) => [o.id, o])).values()];
      if (initial) pages.current = 1;
      if (seen.current) {
        const added = merged.filter((o) => !seen.current!.has(o.id));
        if (added.length) {
          setFresh((f) => new Set([...f, ...added.map((o) => o.id)]));
          if (added.some((o) => o.status === 'NEW')) newestFresh.current = Date.now();
          setFreshTick((n) => n + 1);
          setTimeout(() => setFresh((f) => { const n = new Set(f); added.forEach((o) => n.delete(o.id)); return n; }), 8000);
        }
      }
      seen.current = new Set([...(seen.current ?? []), ...merged.map((o) => o.id)]);
      setItems(merged);
      setNextCursor(cursor);
      setError(null);
    } catch (e) {
      if (my !== gen.current) return;
      setError(describeError(e));
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    pages.current = 1;
    seen.current = null;
    setItems([]); setNextCursor(undefined);
    setFresh(new Set());
    void refresh(true);
    return () => { gen.current++; };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const startKey = key;
    ++gen.current; // discard any in-flight refresh that only holds the first page (it would overwrite the appended page)
    try {
      const page = await listOrders({ ...tab.query, cursor: nextCursor });
      if (activeKey.current !== startKey) return; // tab switched meanwhile
      ++gen.current; // refreshes that began while this page loaded predate it too
      pages.current = Math.min(MAX_REFRESH_PAGES, pages.current + 1);
      setNextCursor(page.nextCursor);
      setItems((prev) => {
        const m = new Map(prev.map((o) => [o.id, o]));
        for (const o of page.items) { m.set(o.id, o); seen.current?.add(o.id); }
        return [...m.values()];
      });
      setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoadingMore(false);
    }
  }, [key, nextCursor]); // eslint-disable-line react-hooks/exhaustive-deps

  return { items, loading, loadingMore, error, fresh, freshTick, newestFresh, hasMore: !!nextCursor, loadMore, refresh: useCallback(() => void refresh(false), [refresh]) };
}

function Retention({ deleteAfter, documentStatus }: { deleteAfter?: string | null | undefined; documentStatus?: string | undefined }) {
  const target = deleteAfter ? Date.parse(deleteAfter) : NaN;
  const secs = useTick(() => (Number.isNaN(target) ? 0 : Math.ceil((target - Date.now()) / 1000)));
  if (documentStatus === 'DELETED') return <span className="sh-chip sh-chip-deleted">File deleted automatically ✓</span>;
  if (Number.isNaN(target)) return null;
  if (secs <= 0) return <span className="sh-chip sh-chip-warn">Deleting…</span>;
  return <span className="sh-chip sh-chip-retention">Deletes in {formatCountdown(secs * 1000)}</span>;
}

function Age({ iso }: { iso: string }) {
  const t = useTick(() => ageLabel(iso));
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{t}</time>;
}

export const OrderCard = memo(function OrderCard({ o, isNew, onChanged }: { o: OrderSummary; isNew: boolean; onChanged?: () => void }) {
  const [busy, setBusy] = useState<'print' | 'save' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const target = o.deleteAfter ? Date.parse(o.deleteAfter) : NaN;
  const secsLeft = useTick(() => (Number.isNaN(target) ? 0 : Math.ceil((target - Date.now()) / 1000)));
  const initiated = !!o.printInitiatedAt;
  const deleted = o.documentStatus === 'DELETED';
  const live = o.status !== 'CANCELLED' && o.status !== 'EXPIRED';
  // Print: a request nobody printed yet. Reprint: Print was pressed and the file is still inside its retention window.
  const canPrint = live && !initiated && o.documentStatus === 'AVAILABLE';
  const canReprint = live && initiated && !deleted && secsLeft > 0;
  const hasFile = canPrint || canReprint;
  async function run(kind: 'print' | 'save') {
    if (busy) return;
    setBusy(kind); setErr(null);
    try {
      if (kind === 'print') await printNowAndOpen(o.id); else await saveFileToDevice(o.id);
    } catch (e) { setErr(describeError(e)); } finally { setBusy(null); onChanged?.(); }
  }
  const pages = o.selectedPageCount != null
    ? (o.pageCount != null && o.pageCount !== o.selectedPageCount ? `${o.selectedPageCount}/${o.pageCount} pages` : `${o.selectedPageCount} pages`)
    : o.pageCount != null ? `${o.pageCount} pages` : null;
  const mins = Math.max(1, Math.ceil(secsLeft / 60));
  return (
    <li className={`sh-card order-card${isNew ? ' is-fresh' : ''}`} data-testid="order-card">
      <div className="order-card-top">
        <Link className="order-card-link" to={`/shop/orders/${o.id}`} aria-label={`Order #${o.orderNumber}`}>
          <span className="order-num">#{o.orderNumber}</span>
        </Link>
        {initiated && <StatusChip status={o.status} />}
        <span className="order-amount tnum">{formatPaise(o.totalPaise)}</span>
      </div>
      {o.customerDisplayNameOrReference && <div className="order-ref sh-ellip" title={o.customerDisplayNameOrReference}>For: {o.customerDisplayNameOrReference}</div>}
      <div className="order-file sh-ellip" title={o.originalFilename ?? undefined}>{o.originalFilename ?? 'Document'}</div>
      <div className="order-meta" data-testid="order-specs">
        {pages && <span>{pages}</span>}
        {o.colourMode && <span>{o.colourMode === 'colour' ? 'Colour' : 'B&W'}</span>}
        {o.copies != null && <span>{o.copies} {o.copies === 1 ? 'copy' : 'copies'}</span>}
        {o.sides && <span>{o.sides === 'duplex' ? 'Double-sided' : 'Single-sided'}</span>}
        {o.pageSelection && <span>{pageSelectionText(o.pageSelection)}</span>}
        <span>{o.paperSize ?? 'A4'}</span>
      </div>
      {hasFile && (
        <div className="order-actions">
          <button className="sh-btn sh-btn-primary sh-btn-lg" disabled={busy !== null} onClick={() => void run('print')}>
            {busy === 'print' ? 'Opening…' : canReprint ? 'Reprint' : 'Print'}
          </button>
          <button className="sh-btn" disabled={busy !== null} onClick={() => void run('save')} title={SAVE_FILE_NOTE}>{busy === 'save' ? 'Saving…' : 'Save file'}</button>
          <Link className="sh-btn sh-btn-sm" to={`/shop/orders/${o.id}`}>View</Link>
        </div>
      )}
      {initiated && <div className="order-initiated sh-muted" data-testid="print-initiated">Print initiated <time dateTime={o.printInitiatedAt!} title={new Date(o.printInitiatedAt!).toLocaleString()}>{new Date(o.printInitiatedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>}
      {canReprint && <div className="order-reprint sh-muted" data-testid="reprint-window">Available for reprint for {mins} min</div>}
      {!hasFile && (
        <div className="order-actions">
          <Link className="sh-btn sh-btn-sm" to={`/shop/orders/${o.id}`}>View details</Link>
        </div>
      )}
      {err && <div className="sh-banner sh-banner-error" role="alert">{err}</div>}
      <div className="order-foot">
        <Age iso={o.createdAt} />
        <Retention deleteAfter={o.deleteAfter} documentStatus={o.documentStatus} />
      </div>
    </li>
  );
});

function useBeep() {
  const [on, setOn] = useState(() => safeStorage()?.getItem('printout.shop.sound') === '1');
  const toggle = () => setOn((v) => { safeStorage()?.setItem('printout.shop.sound', v ? '0' : '1'); return !v; });
  const beep = useCallback(() => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 880; gain.gain.value = 0.05;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.18);
      osc.onended = () => void ctx.close();
    } catch { /* sound is optional */ }
  }, []);
  return { on, toggle, beep };
}

export default function QueuePage() {
  const [tabKey, setTabKey] = useState('new');
  const tab = TABS.find((t) => t.key === tabKey)!;
  const q = useQueue(tab);
  const sound = useBeep();

  const debounced = useDebounced(q.refresh, 300);
  useRealtimeRefresh(debounced);
  useAutoRefresh(q.refresh, 45_000);

  // beep for a newly arrived NEW order (only if the user switched sound on; never autoplays otherwise)
  const lastTick = useRef(0);
  useEffect(() => {
    if (q.freshTick !== lastTick.current) {
      lastTick.current = q.freshTick;
      if (sound.on && q.newestFresh.current && Date.now() - q.newestFresh.current < 2000) sound.beep();
    }
  }, [q.freshTick, q.newestFresh, sound]);

  // when a retention countdown reaches zero, refetch once so the card flips to "File deleted"
  const expired = useTick(() => q.items.filter((o) => o.deleteAfter && o.documentStatus !== 'DELETED' && Date.parse(o.deleteAfter) <= Date.now()).length);
  const refreshSoon = useDebounced(q.refresh, 2000);
  useEffect(() => { if (expired > 0) refreshSoon(); }, [expired, refreshSoon]);

  const empty = !q.loading && q.items.length === 0 && !q.error;
  const fresh = q.fresh;
  const rendered = useMemo(() => q.items.map((o) => <OrderCard key={o.id} o={o} isNew={fresh.has(o.id)} onChanged={q.refresh} />), [q.items, fresh, q.refresh]);

  return (
    <section aria-labelledby="queue-title">
      <div className="sh-pagehead">
        <h1 id="queue-title">Print queue</h1>
        <label className="sh-switch">
          <input type="checkbox" checked={sound.on} onChange={sound.toggle} />
          <span>Sound for new orders</span>
        </label>
      </div>
      <div className="sh-tabs" role="tablist" aria-label="Order filters">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === tabKey} className={`sh-tab${t.key === tabKey ? ' active' : ''}`} onClick={() => setTabKey(t.key)}>{t.label}</button>
        ))}
      </div>
      {q.error && <Banner onRetry={q.refresh}>{q.error}</Banner>}
      <div aria-live="polite" className="sh-sr-only">{q.fresh.size > 0 ? 'New order received' : ''}</div>
      {q.loading ? <Skeleton lines={5} label="Loading orders" /> : null}
      {empty && (
        <div className="sh-empty">
          <h2>{tabKey === 'new' ? 'No new requests' : 'Nothing here yet'}</h2>
          <p>{tabKey === 'new' ? 'New orders appear here the moment customers send them. Show your QR code at the counter to get started.' : 'Orders will show up here as they move along.'}</p>
          {tabKey === 'new' && <Link className="sh-btn" to="/shop/qr">Open counter QR</Link>}
        </div>
      )}
      {q.items.length > 0 && <ul className="order-list">{rendered}</ul>}
      {q.hasMore && (
        <div className="sh-center">
          <button className="sh-btn" onClick={q.loadMore} disabled={q.loadingMore}>{q.loadingMore ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </section>
  );
}
