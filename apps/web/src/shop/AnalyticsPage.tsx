import { useCallback, useEffect, useState } from 'react';
import { formatPaise } from '../lib/format';
import { describeError, getAnalytics, type OrderStatus } from '../lib/shop-api';
import { Banner, Button, Card, CardHeader, OrderStatusChip, SegmentedBar, Skeleton, StatTile } from '../ui';
import { ageLabel } from './hooks';

type Raw = Record<string, unknown>;
const num = (r: Raw, ...keys: string[]): number | null => {
  for (const k of keys) { const v = r[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; }
  return null;
};
const obj = (r: Raw, ...keys: string[]): Record<string, number> | null => {
  for (const k of keys) {
    const v = r[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, number>;
  }
  return null;
};

interface Activity { id?: string; orderId?: string; orderNumber?: string; status?: OrderStatus; toStatus?: OrderStatus; at?: string; totalPaise?: number }

export default function AnalyticsPage() {
  const [data, setData] = useState<Raw | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    getAnalytics().then(setData).catch((e) => setError(describeError(e)));
  }, []);
  useEffect(load, [load]);

  if (error) return <section className="pb-theme pb-page"><h1 className="pb-h1">Analytics</h1><Banner tone="err" actions={<Button size="sm" variant="dark" onClick={load}>Retry</Button>}>{error}</Banner></section>;
  if (!data) return <section className="pb-theme pb-page"><h1 className="pb-h1">Analytics</h1><Skeleton lines={5} label="Loading analytics" /></section>;

  const orders = num(data, 'ordersToday', 'orderCountToday');
  const ordersAll = num(data, 'orderCount');
  const pages = num(data, 'pagesToday', 'pagesRepresented', 'pageCount', 'pages');
  const value = num(data, 'estimatedOrderValuePaise', 'quotedTotalPaise');
  const initiated = num(data, 'printsInitiated');
  const newReq = num(data, 'newPrintRequests');
  const autoDeleted = num(data, 'documentsAutoDeleted');
  const split = obj(data, 'colourSplit', 'byColourMode');
  const bwN = num(data, 'bwCount'), colN = num(data, 'colourCount');
  const colour = split ?? (bwN != null || colN != null ? { bw: bwN ?? 0, colour: colN ?? 0 } : null);
  const bw = colour ? (colour.bw ?? 0) : 0;
  const col = colour ? (colour.colour ?? 0) : 0;
  const colTotal = bw + col;
  const recent = Array.isArray(data.recentActivity) ? (data.recentActivity as Activity[]) : [];

  return (
    <section aria-labelledby="an-title" className="pb-theme pb-page">
      <div className="pb-pagehead">
        <h1 id="an-title" className="pb-h1">Analytics</h1>
        <Button variant="outline" size="sm" iconStart="refresh-cw" onClick={load}>Refresh</Button>
      </div>
      <div className="pb-stats">
        <StatTile label={orders != null ? 'Orders today' : 'Orders'} value={String(orders ?? ordersAll ?? 0)} />
        {pages != null && <StatTile label="Pages" value={String(pages)} />}
        {value != null && <StatTile label="Estimated order value" value={formatPaise(value)} hint="Sum of quoted order totals. Not confirmed payments." />}
        {newReq != null && <StatTile label="New print requests" value={String(newReq)} hint="Waiting for you to press Print." />}
        {initiated != null && <StatTile label="Prints initiated" value={String(initiated)} hint="Times Print was pressed. Does not confirm paper came out." />}
        {autoDeleted != null && <StatTile label="Files deleted automatically" value={String(autoDeleted)} />}
      </div>

      {colour && (
        <Card as="section" aria-labelledby="an-colour">
          <CardHeader id="an-colour" title="B&W vs Colour" />
          {colTotal > 0 ? (
            <SegmentedBar
              summary={`B&W ${bw} orders, Colour ${col} orders`}
              segments={[{ label: 'B&W', value: bw, tone: 'neutral' }, { label: 'Colour', value: col, tone: 'warn' }]}
            />
          ) : <p className="pb-muted">No orders yet.</p>}
        </Card>
      )}

      {recent.length > 0 && (
        <Card as="section" aria-labelledby="an-recent">
          <CardHeader id="an-recent" title="Recent activity" />
          <ul className="pb-recent">
            {recent.map((r, i) => (
              <li key={r.id ?? `${r.orderId}-${i}`}>
                <span>{r.orderNumber ? `#${r.orderNumber}` : 'Order'}</span>
                {(r.toStatus ?? r.status) && <OrderStatusChip status={(r.toStatus ?? r.status)!} size="sm" />}
                {r.totalPaise != null && <span className="pb-order-amount">{formatPaise(r.totalPaise)}</span>}
                {r.at && <span className="pb-muted">{ageLabel(r.at)}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
