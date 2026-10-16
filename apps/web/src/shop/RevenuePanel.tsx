import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatChange, formatInr, bucketLabel, dayLabel, rangeText, revenueRange, revenueRangeError, type RevenuePreset } from '../lib/revenue';
import { istYmd } from '../lib/history';
import { describeError, fetchRevenueCsv, getRevenue, type RevenueBucket, type RevenueReport } from '../lib/shop-api';
import { Banner, BarChart, Button, Card, CardHeader, EmptyState, HBarList, SegmentedControl, Skeleton, StatTile, TextField, ORDER_STATUS_DISPLAY } from '../ui';

const PRESETS: ReadonlyArray<{ value: RevenuePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' }
];
const STORE = 'pb-order-value-range';

/** The chosen range survives a reload within the tab. Storage can be blocked or empty, so every access is guarded. */
function readStored(): { preset: RevenuePreset; from: string; to: string } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE) ?? 'null');
    if (v && PRESETS.some((p) => p.value === v.preset) && typeof v.from === 'string' && typeof v.to === 'string') return v;
  } catch { /* ignore */ }
  return null;
}
function writeStored(v: { preset: RevenuePreset; from: string; to: string }) {
  try { sessionStorage.setItem(STORE, JSON.stringify(v)); } catch { /* ignore */ }
}

function useRevenue(range: { from: string; to: string } | null) {
  const [data, setData] = useState<RevenueReport | null>(null);
  const [loading, setLoading] = useState(range !== null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const gen = useRef(0);
  const key = range ? `${range.from}|${range.to}` : '';
  useEffect(() => {
    if (!range) { setLoading(false); return; }
    const my = ++gen.current;
    const ctl = new AbortController();
    setLoading(true); setError(null);
    getRevenue(range, ctl.signal)
      .then((d) => { if (my === gen.current) { setData(d); setLoading(false); } })
      .catch((e) => { if (my === gen.current && (e as Error).name !== 'AbortError') { setError(describeError(e)); setLoading(false); } });
    return () => ctl.abort();
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, loading, error, retry: () => setAttempt((n) => n + 1) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

function Breakdown({ id, title, items, valueFor }: { id: string; title: string; items: RevenueBucket[]; valueFor: (b: RevenueBucket) => string }) {
  const shown = items.filter((b) => b.orders > 0);
  return (
    <Card as="section" aria-labelledby={id}>
      <CardHeader id={id} as="h3" title={title} />
      {shown.length === 0
        ? <p className="pb-muted">No orders in this period.</p>
        : <HBarList label={title} items={shown.map((b) => ({ label: bucketLabel(b.key), value: b.orders, valueLabel: valueFor(b) }))} />}
    </Card>
  );
}

function Comparison({ d }: { d: RevenueReport }) {
  const c = d.comparison;
  const prev = rangeText(c.previousRange.from, c.previousRange.to);
  if (!c.available) {
    return (
      <p className="pb-muted pb-ov__compare" data-testid="comparison">
        {c.reason === 'NO_PREVIOUS_ORDERS'
          ? `No comparison: there were no orders in the previous period (${prev}).`
          : `No comparison: the previous period (${prev}) starts before your first order, so it is incomplete.`}
      </p>
    );
  }
  const part = (label: string, pct: number | null) => (pct === null ? null : `${label} ${formatChange(pct)}`);
  const parts = [part('estimated value', c.changePct.estimatedOrderValue), part('orders', c.changePct.orderCount), part('pages', c.changePct.pagesRequested)].filter(Boolean);
  return (
    <p className="pb-muted pb-ov__compare" data-testid="comparison">
      Compared with the previous {plural(d.range.days, 'day')} ({prev}): {parts.join(', ')}. Previously {formatInr(c.previous.estimatedOrderValuePaise)} from {plural(c.previous.countedOrders, 'order')}.
    </p>
  );
}

export default function RevenuePanel() {
  const today = istYmd();
  const stored = useMemo(readStored, []);
  const [preset, setPreset] = useState<RevenuePreset>(stored?.preset ?? 'last7');
  const [customFrom, setCustomFrom] = useState(stored?.preset === 'custom' ? stored.from : today);
  const [customTo, setCustomTo] = useState(stored?.preset === 'custom' ? stored.to : today);
  const problem = preset === 'custom' ? revenueRangeError(customFrom, customTo) : null;
  const range = useMemo(() => (preset === 'custom' ? { from: customFrom, to: customTo } : revenueRange(preset)), [preset, customFrom, customTo]);
  const query = problem ? null : range;
  useEffect(() => { if (!problem) writeStored({ preset, ...range }); }, [preset, range, problem]);

  const { data, loading, error, retry } = useRevenue(query);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const exportCsv = useCallback(async () => {
    if (!query || exporting) return;
    setExporting(true); setNote(null);
    try {
      const { blob, filename, truncated } = await fetchRevenueCsv(query);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNote(truncated
        ? { tone: 'warn', text: 'The export was limited to the first 5,000 orders. Choose a shorter date range to export the rest.' }
        : { tone: 'ok', text: `Exported ${filename}. It lists quoted order values only, with no file names or contents.` });
    } catch (e) {
      setNote({ tone: 'err', text: describeError(e) });
    } finally {
      setExporting(false);
    }
  }, [query, exporting]);

  const t = data?.totals;
  // The server's echo of the range is the source of truth for every label on the page.
  const label = data ? rangeText(data.range.from, data.range.to) : query ? rangeText(query.from, query.to) : '';
  const multiDay = (data?.range.days ?? 1) > 1;
  const chart = useMemo(() => {
    if (!data) return null;
    const peak = Math.max(...data.daily.map((p) => p.estimatedOrderValuePaise));
    return data.daily.map((p) => ({
      label: dayLabel(p.date),
      // Whole rupees for the bar height only; exact paise are in the table and tooltips.
      value: Math.round(p.estimatedOrderValuePaise / 100),
      tone: peak > 0 && p.estimatedOrderValuePaise === peak ? ('highlight' as const) : ('default' as const),
      tooltip: `${dayLabel(p.date)}: ${formatInr(p.estimatedOrderValuePaise)} from ${plural(p.countedOrders, 'order')}`
    }));
  }, [data]);
  const peakDay = data ? [...data.daily].sort((a, b) => b.estimatedOrderValuePaise - a.estimatedOrderValuePaise)[0] : undefined;

  return (
    <section aria-labelledby="ov-title" className="pb-ov">
      <div className="pb-pagehead">
        <div>
          <h2 id="ov-title" className="pb-h2">Order value report</h2>
          <p className="pb-muted pb-pagehead__sub">Quoted order values for the days you choose (India time).</p>
        </div>
        <Button variant="outline" size="sm" iconStart="download" loading={exporting} disabled={!query || exporting || !!error} onClick={() => void exportCsv()}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      <Banner tone="info" title="Estimates, not payments">
        These figures add up the prices quoted when customers placed orders. Printout Buddy does not record cash or online payments, so money received, refunds and net earnings are not available here.
      </Banner>

      {note && <Banner tone={note.tone} onDismiss={() => setNote(null)}>{note.text}</Banner>}

      <div className="pb-historyfilters" role="search" aria-label="Order value date range">
        <SegmentedControl label="Date range" options={PRESETS} value={preset} onChange={setPreset} />
        {preset === 'custom' && (
          <div className="pb-historyfilters__dates">
            <TextField label="From" type="date" value={customFrom} max={today} onChange={(e) => setCustomFrom(e.target.value)} error={problem && !customFrom ? problem : null} />
            <TextField label="To" type="date" value={customTo} max={today} onChange={(e) => setCustomTo(e.target.value)} error={problem && customFrom ? problem : null} />
          </div>
        )}
      </div>

      {error && <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={retry}>Retry</Button>}>{error}</Banner>}
      {loading && !data && !error && <Skeleton lines={4} label="Loading order value report" />}

      {data && t && !error && (
        <div aria-busy={loading || undefined}>
          <p className="pb-sr-only" role="status" aria-live="polite">{loading ? 'Updating report' : `Report for ${label} loaded`}</p>
          {t.orderCount === 0 ? (
            <Card padding="none">
              <EmptyState icon="chart-column" titleAs="h3" title="No orders in this period">
                Orders customers place between {label.replace(' to ', ' and ')} will appear here. Try a wider date range.
              </EmptyState>
            </Card>
          ) : (
            <>
              <div className="pb-stats pb-ov__stats" aria-label={`Summary for ${label}`}>
                <StatTile label="Estimated order value" value={formatInr(t.estimatedOrderValuePaise)}
                  hint="Prices quoted on orders that were not cancelled or expired. Not money received." />
                <StatTile label="Orders" value={t.orderCount.toLocaleString('en-IN')}
                  hint={`${plural(t.countedOrders, 'order')} counted in the value above.`} />
                <StatTile label="Print started" value={t.printStarted.toLocaleString('en-IN')} hint="Times Print was pressed. Does not confirm paper came out." />
                <StatTile label="Pages requested" value={t.pagesRequested.toLocaleString('en-IN')}
                  hint={t.ordersWithUnknownPages > 0 ? `Pages × copies. ${plural(t.ordersWithUnknownPages, 'order')} had no page count recorded and ${t.ordersWithUnknownPages === 1 ? 'is' : 'are'} not included.` : 'Pages × copies on counted orders.'} />
                <StatTile label="Average estimated order value" value={t.averageEstimatedOrderValuePaise === null ? 'Not available' : formatInr(t.averageEstimatedOrderValuePaise)}
                  hint="Estimated order value ÷ counted orders." />
                <StatTile label="Cancelled or expired" value={`${t.cancelled} / ${t.expired}`}
                  hint={`${t.cancelled} cancelled, ${t.expired} expired. Their quoted ${formatInr(t.excludedQuotedValuePaise)} is not counted.`} />
              </div>
              {t.zeroValueOrders > 0 && <p className="pb-muted">{plural(t.zeroValueOrders, 'counted order')} had a quoted value of ₹0.00.</p>}
              <Comparison d={data} />

              <Card as="section" aria-labelledby="ov-trend">
                <CardHeader id="ov-trend" as="h3" title="Estimated order value by day" meta={label} />
                {chart && (
                  <BarChart
                    data={chart}
                    title={`Estimated order value per day in rupees, ${label}`}
                    summary={peakDay && peakDay.estimatedOrderValuePaise > 0 ? `Highest on ${dayLabel(peakDay.date)} at ${formatInr(peakDay.estimatedOrderValuePaise)}. Total ${formatInr(t.estimatedOrderValuePaise)}.` : 'No value in this period.'}
                    yAxisLabel="₹"
                    valueName="Rupees (rounded)"
                    valueLabels={data.daily.length <= 10}
                    labelEvery={Math.max(1, Math.ceil(data.daily.length / 8))}
                    height={240}
                  />
                )}
                <details className="pb-ov__table">
                  <summary>View as table</summary>
                  <div className="pb-ov__scroll" role="region" aria-label="Daily values table, scrollable" tabIndex={0}>
                    <table>
                      <caption className="pb-sr-only">Daily order value and volume, {label}</caption>
                      <thead>
                        <tr><th scope="col">Date</th><th scope="col">Orders</th><th scope="col">Counted</th><th scope="col">Pages</th><th scope="col">Estimated value</th></tr>
                      </thead>
                      <tbody>
                        {data.daily.map((p) => (
                          <tr key={p.date}>
                            <th scope="row">{dayLabel(p.date)}</th><td>{p.orders}</td><td>{p.countedOrders}</td><td>{p.pagesRequested.toLocaleString('en-IN')}</td><td>{formatInr(p.estimatedOrderValuePaise)}</td>
                          </tr>
                        ))}
                      </tbody>
                      {multiDay && (
                        <tfoot>
                          <tr><th scope="row">Total</th><td>{t.orderCount}</td><td>{t.countedOrders}</td><td>{t.pagesRequested.toLocaleString('en-IN')}</td><td>{formatInr(t.estimatedOrderValuePaise)}</td></tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </details>
              </Card>

              <div className="pb-ov__grid">
                <Breakdown id="ov-colour" title="Black & white vs colour" items={data.breakdown.colourMode} valueFor={(b) => `${plural(b.orders, 'order')} · ${formatInr(b.valuePaise)}`} />
                <Breakdown id="ov-sides" title="Single vs double-sided" items={data.breakdown.sides} valueFor={(b) => `${plural(b.orders, 'order')} · ${formatInr(b.valuePaise)}`} />
                <Breakdown id="ov-paper" title="Paper size" items={data.breakdown.paperSize} valueFor={(b) => `${plural(b.orders, 'order')} · ${formatInr(b.valuePaise)}`} />
                <Card as="section" aria-labelledby="ov-status">
                  <CardHeader id="ov-status" as="h3" title="Orders by status" />
                  <HBarList
                    label="Orders by status"
                    items={data.breakdown.status.filter((b) => b.orders > 0).map((b) => ({
                      label: ORDER_STATUS_DISPLAY[b.key as keyof typeof ORDER_STATUS_DISPLAY]?.label ?? b.key,
                      value: b.orders,
                      valueLabel: plural(b.orders, 'order')
                    }))}
                  />
                </Card>
              </div>
              <p className="pb-muted pb-ov__defs">
                How this is worked out: orders are grouped by the day they were placed. Estimated order value is the sum of each order's quoted total, saved when the order was placed, so later price changes never rewrite past days. Cancelled and expired orders are left out of value, pages, average and the breakdowns.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
