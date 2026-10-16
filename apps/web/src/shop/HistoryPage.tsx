import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatPaise } from '../lib/format';
import {
  HISTORY_STATUS_OPTIONS, istStamp, istTime, istTimeSeconds, presetRange, rangeError, rangeLabel, istYmd, type HistoryPreset
} from '../lib/history';
import {
  describeError, fetchHistoryCsv, getHistorySummary, listHistory, type HistoryItem, type HistoryQuery, type HistorySummary
} from '../lib/shop-api';
import {
  Banner, Button, Card, DataTable, EmptyState, Icon, JobCode, LoadMore, OrderStatusChip, Select, SegmentedControl, StatTile, TextField, type Column
} from '../ui';
import { useDebounced } from './hooks';
import './pb-pages.css';

const PAGE_SIZE = 25;
const PRESETS: ReadonlyArray<{ value: HistoryPreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'custom', label: 'Custom' }
];

const pagesLabel = (i: HistoryItem): string | null =>
  i.selectedPageCount != null
    ? (i.pageCount != null && i.pageCount !== i.selectedPageCount ? `${i.selectedPageCount}/${i.pageCount} pages` : `${i.selectedPageCount} pages`)
    : i.pageCount != null ? `${i.pageCount} pages` : null;

/** Loads page one plus the summary whenever the query changes; later pages append. Stale responses are discarded. */
function useHistory(query: HistoryQuery | null) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [loading, setLoading] = useState(query !== null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const gen = useRef(0);
  const key = query ? JSON.stringify(query) : '';

  useEffect(() => {
    if (!query) { setLoading(false); return; }
    const my = ++gen.current;
    const ctl = new AbortController();
    setLoading(true); setError(null); setMoreError(null); setSummaryError(false); setSummary(null); setItems([]); setNextCursor(undefined);
    listHistory({ ...query, limit: PAGE_SIZE }, ctl.signal)
      .then((p) => { if (my !== gen.current) return; setItems(p.items); setNextCursor(p.nextCursor); })
      .catch((e) => { if (my === gen.current && (e as Error).name !== 'AbortError') setError(describeError(e)); })
      .finally(() => { if (my === gen.current) setLoading(false); });
    getHistorySummary(query, ctl.signal)
      .then((s) => { if (my === gen.current) setSummary(s); })
      .catch((e) => { if (my === gen.current && (e as Error).name !== 'AbortError') setSummaryError(true); });
    return () => ctl.abort();
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(async () => {
    if (!query || !nextCursor || loadingMore) return;
    const my = gen.current;
    setLoadingMore(true); setMoreError(null);
    try {
      const p = await listHistory({ ...query, cursor: nextCursor, limit: PAGE_SIZE });
      if (my !== gen.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...p.items.filter((i) => !seen.has(i.id))];
      });
      setNextCursor(p.nextCursor);
    } catch (e) {
      if (my === gen.current) setMoreError(describeError(e));
    } finally {
      if (my === gen.current) setLoadingMore(false);
    }
  }, [query, nextCursor, loadingMore]);

  return { items, summary, loading, loadingMore, error, moreError, summaryError, hasMore: !!nextCursor, loadMore, retry: () => setAttempt((n) => n + 1) };
}

function SettingsText({ i }: { i: HistoryItem }) {
  return (
    <div className="pb-settings">
      {i.colourMode && <span>{i.colourMode === 'colour' ? 'Colour' : 'B&W'}</span>}
      {i.sides && <span>{i.sides === 'duplex' ? 'Double-sided' : 'Single-sided'}</span>}
      <span>{i.paperSize ?? 'A4'}</span>
    </div>
  );
}

function SpecsText({ i }: { i: HistoryItem }) {
  const pages = pagesLabel(i);
  const copies = i.copies != null ? `${i.copies} ${i.copies === 1 ? 'copy' : 'copies'}` : null;
  return (
    <div className="pb-specs">
      {pages && <span>{pages}</span>}
      {pages && copies && <span className="pb-specs__x" aria-hidden="true">×</span>}
      {copies && <span>{copies}</span>}
    </div>
  );
}

function StatusText({ i }: { i: HistoryItem }) {
  return (
    <div className="pb-statuscell">
      <OrderStatusChip status={i.status} />
      {i.printInitiatedAt && (
        <div className="pb-statuscell__line" data-testid="print-initiated" title="Print was pressed. This does not confirm that paper came out.">
          Print initiated <time dateTime={i.printInitiatedAt}>{istTime(i.printInitiatedAt)}</time>
        </div>
      )}
    </div>
  );
}

/** Deletion column: the server's deletion time once the file is gone, otherwise plain words (never a promise). */
function DeletedText({ i }: { i: HistoryItem }) {
  if (i.documentStatus === 'DELETED') {
    return i.fileDeletedAt
      ? <time className="pb-mono" dateTime={i.fileDeletedAt}>{istTimeSeconds(i.fileDeletedAt)}</time>
      : <span>Deleted</span>;
  }
  if (i.documentStatus === 'AVAILABLE' || i.documentStatus === 'PRINTED_RETENTION') return <span className="pb-muted">Not yet</span>;
  return <span className="pb-muted">—</span>;
}

const HistoryCard = memo(function HistoryCard({ i, withDate }: { i: HistoryItem; withDate: boolean }) {
  return (
    <div className="pb-ordercard pb-historycard">
      <div className="pb-ordercard__top">
        <Link className="pb-order-link" to={`/shop/orders/${i.id}`} aria-label={`Order #${i.orderNumber}`}><JobCode code={`#${i.orderNumber}`} /></Link>
        <OrderStatusChip status={i.status} />
      </div>
      <div className="pb-file">
        <div className="pb-file__name pb-ellipsis" title={i.originalFilename}>{i.originalFilename}</div>
        <div className="pb-file__age"><time dateTime={i.createdAt}>{istStamp(i.createdAt, withDate)}</time></div>
      </div>
      <div className="pb-ordercard__specs">
        <SpecsText i={i} />
        <SettingsText i={i} />
      </div>
      <dl className="pb-historycard__meta">
        <div><dt>By</dt><dd>{i.handledBy ?? '—'}</dd></div>
        <div><dt>File deleted</dt><dd><DeletedText i={i} /></dd></div>
        {i.printInitiatedAt && <div><dt>Print initiated</dt><dd><time dateTime={i.printInitiatedAt}>{istTime(i.printInitiatedAt)}</time></dd></div>}
        <div><dt>Estimated total</dt><dd>{formatPaise(i.totalPaise)}</dd></div>
      </dl>
    </div>
  );
});

export default function HistoryPage() {
  const today = istYmd();
  const [preset, setPreset] = useState<HistoryPreset>('today');
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const applySearch = useDebounced(() => setQ(search), 300);
  useEffect(applySearch, [search, applySearch]);

  const customProblem = preset === 'custom' ? rangeError(customFrom, customTo) : null;
  const range = useMemo(() => (preset === 'custom' ? { from: customFrom, to: customTo } : presetRange(preset)), [preset, customFrom, customTo]);
  const query = useMemo<HistoryQuery | null>(
    () => (customProblem ? null : { from: range.from, to: range.to, ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) }),
    [customProblem, range, status, q]
  );
  const h = useHistory(query);
  const multiDay = range.from !== range.to;
  const filtered = status !== '' || q.trim() !== '';
  const label = rangeLabel(preset, range.from, range.to);

  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  async function exportCsv() {
    if (!query || exporting) return;
    setExporting(true); setExportNote(null);
    try {
      const { blob, filename, truncated } = await fetchHistoryCsv(query);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportNote(truncated
        ? { tone: 'warn', text: 'The export was limited to the first 5,000 rows. Choose a shorter date range to export the rest.' }
        : { tone: 'ok', text: `Exported ${filename}. It contains order details only, never file contents.` });
    } catch (e) {
      setExportNote({ tone: 'err', text: describeError(e) });
    } finally {
      setExporting(false);
    }
  }

  function clearFilters() { setStatus(''); setSearch(''); setQ(''); }

  const columns = useMemo<Column<HistoryItem>[]>(() => [
    { key: 'time', header: 'Time', cell: (i) => <time dateTime={i.createdAt} className="pb-nowrap">{istStamp(i.createdAt, multiDay)}</time> },
    { key: 'code', header: 'Code', cell: (i) => <Link className="pb-order-link" to={`/shop/orders/${i.id}`} aria-label={`Order #${i.orderNumber}`}><JobCode code={`#${i.orderNumber}`} /></Link> },
    { key: 'file', header: 'File', cell: (i) => <div className="pb-file"><div className="pb-file__name pb-ellipsis" title={i.originalFilename}>{i.originalFilename}</div></div> },
    { key: 'specs', header: 'Pages × copies', cell: (i) => <SpecsText i={i} /> },
    { key: 'settings', header: 'Settings', cell: (i) => <SettingsText i={i} /> },
    { key: 'status', header: 'Status', cell: (i) => <StatusText i={i} /> },
    { key: 'by', header: 'By', cell: (i) => <span>{i.handledBy ?? '—'}</span> },
    { key: 'deleted', header: 'File deleted', cell: (i) => <DeletedText i={i} /> }
  ], [multiDay]);

  const s = h.summary;
  const showEmpty = !h.loading && !h.error && query !== null && h.items.length === 0;

  return (
    <section aria-labelledby="hist-title" className="pb-theme pb-page pb-page--wide">
      <div className="pb-pagehead">
        <div>
          <h1 id="hist-title" className="pb-h1">History</h1>
          <p className="pb-muted pb-pagehead__sub">Order details only. This page never opens, downloads or reprints files; use the Print queue for files that are still available. <Link to="/shop/analytics">View analytics</Link>.</p>
        </div>
        <Button variant="outline" size="sm" iconStart="download" loading={exporting} disabled={!query || exporting || !!h.error} onClick={() => void exportCsv()}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      {exportNote && <Banner tone={exportNote.tone} onDismiss={() => setExportNote(null)}>{exportNote.text}</Banner>}

      <div className="pb-historyfilters" role="search" aria-label="History filters">
        <SegmentedControl label="Date range" options={PRESETS} value={preset} onChange={setPreset} />
        {preset === 'custom' && (
          <div className="pb-historyfilters__dates">
            <TextField label="From" type="date" value={customFrom} max={today} onChange={(e) => setCustomFrom(e.target.value)} error={customProblem && !customFrom ? customProblem : null} />
            <TextField label="To" type="date" value={customTo} max={today} onChange={(e) => setCustomTo(e.target.value)} error={customProblem && customFrom ? customProblem : null} />
          </div>
        )}
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {HISTORY_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <TextField
          label="Code or file name" hideLabel type="search" placeholder="Code or file name" value={search} maxLength={100}
          startAdornment={<span aria-hidden="true">⌕</span>} onChange={(e) => setSearch(e.target.value)} autoComplete="off" wrapperClassName="pb-historyfilters__search"
        />
      </div>

      {query && (
        <div className="pb-stats" aria-label={`Summary for ${label}`}>
          <StatTile label={`${label}: orders`} value={s ? String(s.total) : '–'} loading={h.loading && !s && !h.summaryError} />
          <StatTile label="Print initiated" value={s ? String(s.printInitiated) : '–'} hint="Times Print was pressed. Does not confirm paper came out." />
          <StatTile label="Cancelled" value={s ? String(s.byStatus.CANCELLED) : '–'} />
          <StatTile label="Expired" value={s ? String(s.byStatus.EXPIRED) : '–'} />
          <StatTile label="Files deleted" value={s ? String(s.filesDeleted) : '–'} hint="Deleted automatically after Print or expiry." />
        </div>
      )}
      {h.summaryError && !h.error && <Banner tone="warn" actions={<Button size="sm" variant="dark" onClick={h.retry}>Retry</Button>}>The summary could not be loaded.</Banner>}

      {h.error && <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={h.retry}>Retry</Button>}>{h.error}</Banner>}

      <p className="pb-sr-only" role="status" aria-live="polite">
        {h.loading ? 'Loading history' : query && !h.error ? `${h.items.length} ${h.items.length === 1 ? 'order' : 'orders'} shown${h.hasMore ? ', more available' : ''}` : ''}
      </p>

      {showEmpty && (
        <Card padding="none">
          <EmptyState
            icon="clock"
            titleAs="h2"
            title={filtered ? 'No orders match these filters' : `No orders ${preset === 'today' ? 'today' : 'in this period'}`}
            action={filtered ? <Button variant="outline" onClick={clearFilters}>Clear filters</Button> : undefined}
          >
            {filtered ? 'Try a different status or search, or choose a wider date range.' : 'Orders appear here once customers send them. Older orders stay here after their files are deleted.'}
          </EmptyState>
        </Card>
      )}

      {query && !h.error && (h.loading || h.items.length > 0) && (
        <DataTable
          caption={`Order history, ${label}`}
          columns={columns}
          rows={h.items}
          getRowKey={(i) => i.id}
          loading={h.loading}
          loadingLabel="Loading history"
          rowAttributes={() => ({ 'data-testid': 'history-row' })}
          renderCard={(i) => <HistoryCard i={i} withDate={multiDay} />}
          footer={!h.loading && (
            <LoadMore
              hasMore={h.hasMore}
              loading={h.loadingMore}
              onClick={() => void h.loadMore()}
              endLabel="End of results"
              summary={`Showing ${h.items.length}`}
              error={h.moreError ? <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => void h.loadMore()}>Retry</Button>}>{h.moreError}</Banner> : undefined}
            />
          )}
        />
      )}
    </section>
  );
}
