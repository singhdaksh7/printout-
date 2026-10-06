import { useCallback, useEffect, useState } from 'react';
import { formatPaise } from '../lib/format';
import { describeError, getAnalytics, type OrderStatus } from '../lib/shop-api';
import { Banner, Skeleton, StatusChip } from './components';
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

  if (error) return <section><h1>Analytics</h1><Banner onRetry={load}>{error}</Banner></section>;
  if (!data) return <section><h1>Analytics</h1><Skeleton lines={5} label="Loading analytics" /></section>;

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
    <section aria-labelledby="an-title">
      <div className="sh-pagehead"><h1 id="an-title">Analytics</h1><button className="sh-btn sh-btn-sm" onClick={load}>Refresh</button></div>
      <div className="an-cards">
        <Stat label={orders != null ? 'Orders today' : 'Orders'} value={String(orders ?? ordersAll ?? 0)} />
        {pages != null && <Stat label="Pages" value={String(pages)} />}
        {value != null && <Stat label="Estimated order value" value={formatPaise(value)} hint="Sum of quoted order totals. Not confirmed payments." />}
        {newReq != null && <Stat label="New print requests" value={String(newReq)} hint="Waiting for you to press Print." />}
        {initiated != null && <Stat label="Prints initiated" value={String(initiated)} hint="Times Print was pressed. Does not confirm paper came out." />}
        {autoDeleted != null && <Stat label="Files deleted automatically" value={String(autoDeleted)} />}
      </div>

      {colour && (
        <div className="sh-card">
          <h2>B&amp;W vs Colour</h2>
          {colTotal > 0 ? (
            <>
              <div className="an-bar" role="img" aria-label={`B&W ${bw} orders, Colour ${col} orders`}>
                <div className="an-bar-bw" style={{ width: `${(bw / colTotal) * 100}%` }} />
                <div className="an-bar-colour" style={{ width: `${(col / colTotal) * 100}%` }} />
              </div>
              <div className="an-legend"><span><i className="an-dot an-bar-bw" /> B&amp;W {bw}</span><span><i className="an-dot an-bar-colour" /> Colour {col}</span></div>
            </>
          ) : <p className="sh-muted">No orders yet.</p>}
        </div>
      )}

      {recent.length > 0 && (
        <div className="sh-card">
          <h2>Recent activity</h2>
          <ul className="an-recent">
            {recent.map((a, i) => (
              <li key={a.id ?? `${a.orderId}-${i}`}>
                <span>{a.orderNumber ? `#${a.orderNumber}` : 'Order'}</span>
                {(a.toStatus ?? a.status) && <StatusChip status={(a.toStatus ?? a.status)!} />}
                {a.totalPaise != null && <span className="tnum">{formatPaise(a.totalPaise)}</span>}
                {a.at && <span className="sh-muted">{ageLabel(a.at)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="sh-card an-stat">
      <div className="an-stat-label">{label}</div>
      <div className="an-stat-value tnum">{value}</div>
      {hint && <div className="sh-muted an-stat-hint">{hint}</div>}
    </div>
  );
}
