import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatCountdown, formatPaise } from '../lib/format';
import { retentionPhrase } from '../lib/retention';
import { getAnalytics, listOrders, describeError, type OrderSummary } from '../lib/shop-api';
import { Banner, Button, Card, Chip, DataTable, EmptyState, JobCode, LoadMore, OrderStatusChip, StatTile, Switch, Tabs, buttonClass, cx, type Column } from '../ui';
import { pageSelectionText } from './components';
import { useAuth } from './auth';
import { ageLabel, safeStorage, useAutoRefresh, useDebounced, useTick } from './hooks';
import { printNowAndOpen, saveFileToDevice, SAVE_FILE_NOTE } from './print-actions';
import { useRealtimeRefresh } from './realtime';
import './pb-pages.css';

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
  if (documentStatus === 'DELETED') return <Chip tone="ok" size="sm" dot={false}>File deleted automatically ✓</Chip>;
  if (Number.isNaN(target)) return null;
  if (secs <= 0) return <Chip tone="warn" size="sm">Deleting…</Chip>;
  return <Chip tone="orange" size="sm">Deletes in {formatCountdown(secs * 1000)}</Chip>;
}

function Age({ iso }: { iso: string }) {
  const t = useTick(() => ageLabel(iso));
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{t}</time>;
}

/** What the shopkeeper may do with an order's file right now (unchanged rules; the server still enforces access). */
function useOrderFlags(o: OrderSummary) {
  const target = o.deleteAfter ? Date.parse(o.deleteAfter) : NaN;
  const secsLeft = useTick(() => (Number.isNaN(target) ? 0 : Math.ceil((target - Date.now()) / 1000)));
  const initiated = !!o.printInitiatedAt;
  const deleted = o.documentStatus === 'DELETED';
  const live = o.status !== 'CANCELLED' && o.status !== 'EXPIRED';
  // Print: a request nobody printed yet. Reprint: Print was pressed and the file is still inside its retention window.
  const canPrint = live && !initiated && o.documentStatus === 'AVAILABLE';
  const canReprint = live && initiated && !deleted && secsLeft > 0;
  return { secsLeft, initiated, canPrint, canReprint, hasFile: canPrint || canReprint };
}

const pagesLabel = (o: OrderSummary) =>
  o.selectedPageCount != null
    ? (o.pageCount != null && o.pageCount !== o.selectedPageCount ? `${o.selectedPageCount}/${o.pageCount} pages` : `${o.selectedPageCount} pages`)
    : o.pageCount != null ? `${o.pageCount} pages` : null;

function OrderCell({ o }: { o: OrderSummary }) {
  return (
    <div className="pb-order-id">
      <Link className="pb-order-link" to={`/shop/orders/${o.id}`} aria-label={`Order #${o.orderNumber}`}>
        <JobCode code={`#${o.orderNumber}`} />
      </Link>
      <span className="pb-order-amount">{formatPaise(o.totalPaise)}</span>
    </div>
  );
}

function FileCell({ o }: { o: OrderSummary }) {
  const ref = o.customerDisplayNameOrReference;
  return (
    <div className="pb-file">
      <div className="pb-file__name pb-ellipsis" title={o.originalFilename ?? undefined}>{o.originalFilename ?? 'Document'}</div>
      {ref && <div className="pb-file__ref pb-ellipsis" title={ref}>For: {ref}</div>}
      <div className="pb-file__age">Received <Age iso={o.createdAt} /></div>
    </div>
  );
}

function SpecsCell({ o }: { o: OrderSummary }) {
  const pages = pagesLabel(o);
  const copies = o.copies != null ? `${o.copies} ${o.copies === 1 ? 'copy' : 'copies'}` : null;
  return (
    <div className="pb-specs">
      {pages && <span>{pages}</span>}
      {pages && copies && <span className="pb-specs__x" aria-hidden="true">×</span>}
      {copies && <span>{copies}</span>}
    </div>
  );
}

function SettingsCell({ o }: { o: OrderSummary }) {
  return (
    <div className="pb-settings" data-testid="order-specs">
      <div className="pb-settings__line">
        {o.colourMode && <span>{o.colourMode === 'colour' ? 'Colour' : 'B&W'}</span>}
        {o.sides && <span>{o.sides === 'duplex' ? 'Double-sided' : 'Single-sided'}</span>}
      </div>
      <div className="pb-settings__line">
        {o.pageSelection && <span>{pageSelectionText(o.pageSelection)}</span>}
        <span>{o.paperSize ?? 'A4'}</span>
      </div>
    </div>
  );
}

/** A status chip for queue rows. NEW is the state of every row in the New tab (nothing has happened yet), so a chip would only repeat the tab; later states carry information and are shown. */
function QueueStatusChip({ status }: { status: OrderSummary['status'] }) {
  return status === 'NEW' ? null : <OrderStatusChip status={status} />;
}

function StatusCell({ o, showChip = true }: { o: OrderSummary; showChip?: boolean }) {
  const f = useOrderFlags(o);
  const mins = Math.max(1, Math.ceil(f.secsLeft / 60));
  return (
    <div className="pb-statuscell">
      {showChip && <QueueStatusChip status={o.status} />}
      {f.initiated && (
        <div className="pb-statuscell__line" data-testid="print-initiated">
          Print initiated <time dateTime={o.printInitiatedAt!} title={new Date(o.printInitiatedAt!).toLocaleString()}>{new Date(o.printInitiatedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      )}
      {f.canReprint && <div className="pb-statuscell__line" data-testid="reprint-window">Available for reprint for {mins} min</div>}
      <Retention deleteAfter={o.deleteAfter} documentStatus={o.documentStatus} />
    </div>
  );
}

/** Print / Reprint, Save file and View for one order. `stacked` is the phone card layout (full-width buttons). */
function RowActions({ o, onChanged, stacked = false }: { o: OrderSummary; onChanged?: (() => void) | undefined; stacked?: boolean }) {
  const [busy, setBusy] = useState<'print' | 'save' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const f = useOrderFlags(o);
  async function run(kind: 'print' | 'save') {
    if (busy) return;
    setBusy(kind); setErr(null);
    try {
      if (kind === 'print') await printNowAndOpen(o.id); else await saveFileToDevice(o.id);
    } catch (e) { setErr(describeError(e)); } finally { setBusy(null); onChanged?.(); }
  }
  return (
    <div className={cx('pb-actions', stacked && 'pb-actions--stacked')}>
      {f.hasFile && (
        <>
          <Button variant="dark" size={stacked ? 'md' : 'sm'} loading={busy === 'print'} disabled={busy !== null} onClick={() => void run('print')}>
            {busy === 'print' ? 'Opening…' : f.canReprint ? 'Reprint' : 'Print'}
          </Button>
          <Button variant="outline" size="sm" loading={busy === 'save'} disabled={busy !== null} onClick={() => void run('save')} title={SAVE_FILE_NOTE}>
            {busy === 'save' ? 'Saving…' : 'Save file'}
          </Button>
        </>
      )}
      <Link className={buttonClass({ variant: 'ghost', size: 'sm', className: 'pb-actions__view' })} to={`/shop/orders/${o.id}`}>{f.hasFile ? 'View' : 'View details'}</Link>
      {err && <Banner tone="err" icon={false}>{err}</Banner>}
    </div>
  );
}

const OrderCard = memo(function OrderCard({ o, onChanged }: { o: OrderSummary; onChanged?: (() => void) | undefined }) {
  return (
    <div className="pb-ordercard">
      <div className="pb-ordercard__top">
        <OrderCell o={o} />
        <QueueStatusChip status={o.status} />
      </div>
      <FileCell o={o} />
      <div className="pb-ordercard__specs">
        <SpecsCell o={o} />
        <SettingsCell o={o} />
      </div>
      <StatusCell o={o} showChip={false} />
      <RowActions o={o} stacked {...(onChanged ? { onChanged } : {})} />
    </div>
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
  const { state: auth } = useAuth();
  const retentionMinutes = auth.status === 'authed' ? auth.session.retentionMinutes : undefined;

  // Summary strip from the real analytics endpoint (approved design: waiting / today / pages). Best effort: the queue works without it.
  const [stats, setStats] = useState<{ waiting: number; orders: number; pages: number; initiated: number } | null>(null);
  const loadStats = useCallback(() => {
    void Promise.resolve()
      .then(() => getAnalytics())
      .then((d) => {
        const n = (k: string) => (typeof d?.[k] === 'number' ? (d[k] as number) : 0);
        setStats({ waiting: n('newPrintRequests'), orders: n('ordersToday'), pages: n('pagesToday'), initiated: n('printsInitiated') });
      })
      .catch(() => setStats(null));
  }, []);
  useEffect(loadStats, [loadStats]);
  const refreshAll = useCallback(() => { q.refresh(); loadStats(); }, [q.refresh, loadStats]);

  const debounced = useDebounced(refreshAll, 300);
  useRealtimeRefresh(debounced);
  useAutoRefresh(refreshAll, 45_000);

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
  const refresh = q.refresh;
  // Every row on the New tab is a request nobody printed yet, so its Status cell is empty until Print is pressed: drop the column then.
  const showStatus = tabKey !== 'new' || q.items.some((o) => o.status !== 'NEW' || !!o.printInitiatedAt || !!o.deleteAfter || o.documentStatus === 'DELETED');
  const columns = useMemo<Column<OrderSummary>[]>(() => [
    { key: 'order', header: 'Order', cell: (o) => <OrderCell o={o} /> },
    { key: 'file', header: 'File', cell: (o) => <FileCell o={o} /> },
    { key: 'specs', header: 'Pages × copies', cell: (o) => <SpecsCell o={o} /> },
    { key: 'settings', header: 'Settings', cell: (o) => <SettingsCell o={o} /> },
    ...(showStatus ? [{ key: 'status', header: 'Status', cell: (o: OrderSummary) => <StatusCell o={o} /> }] : []),
    { key: 'action', header: 'Action', srOnlyHeader: true, align: 'end', cell: (o) => <RowActions o={o} onChanged={refresh} /> }
  ], [refresh, showStatus]);

  return (
    <section aria-labelledby="queue-title" className="pb-theme pb-page pb-page--wide">
      <div className="pb-pagehead">
        <div>
          <h1 id="queue-title" className="pb-h1">Print queue</h1>
          <p className="pb-muted pb-pagehead__sub">Newest first. Files are deleted automatically {retentionPhrase(retentionMinutes)} after you press Print.</p>
        </div>
        <Switch label="Sound for new orders" checked={sound.on} onChange={sound.toggle} />
      </div>
      {stats && (
        <div className="pb-stats pb-stats--queue" aria-label="Today at a glance" role="group" data-testid="queue-stats">
          <StatTile label="Waiting for print" value={String(stats.waiting)} hint="New requests you have not printed yet." />
          <StatTile label="Orders today" value={String(stats.orders)} />
          <StatTile label="Pages today" value={String(stats.pages)} hint="Pages x copies, excluding cancelled and expired." />
          <StatTile label="Prints started today" value={String(stats.initiated)} hint="Times Print was pressed." />
        </div>
      )}
      <Tabs label="Order filters" idPrefix="queue" panelId="queue-panel" tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} value={tabKey} onChange={setTabKey} />
      <div id="queue-panel" role="tabpanel" aria-labelledby={`queue-tab-${tabKey}`} className="pb-page">
        {q.error && <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={q.refresh}>Retry</Button>}>{q.error}</Banner>}
        <div aria-live="polite" className="pb-sr-only">{q.fresh.size > 0 ? 'New order received' : ''}</div>
        {empty && (
          <Card padding="none">
            <EmptyState
              icon="printer"
              titleAs="h2"
              title={tabKey === 'new' ? 'No new requests' : 'Nothing here yet'}
              action={tabKey === 'new' ? <Link className={buttonClass({ variant: 'outline' })} to="/shop/qr">Open counter QR</Link> : undefined}
            >
              {tabKey === 'new' ? 'New orders appear here the moment customers send them. Show your QR code at the counter to get started.' : 'Orders will show up here as they move along.'}
            </EmptyState>
          </Card>
        )}
        {(q.loading || q.items.length > 0) && (
          <DataTable
            caption="Orders"
            columns={columns}
            rows={q.items}
            getRowKey={(o) => o.id}
            loading={q.loading}
            loadingLabel="Loading orders"
            highlightKeys={q.fresh}
            rowAttributes={() => ({ 'data-testid': 'order-card' })}
            renderCard={(o) => <OrderCard o={o} onChanged={refresh} />}
          />
        )}
        {q.hasMore && <LoadMore hasMore loading={q.loadingMore} onClick={q.loadMore} />}
      </div>
    </section>
  );
}
