import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatCountdown, formatPaise } from '../lib/format';
import type { HistoryEntry, OrderStatus, TrackedOrder } from '../lib/customer-api';
import { getRecentOrders } from '../lib/customer-storage';
import { describeOptions } from './config';
import { Alert, NotFound, Skeleton } from './parts';
import { TERMINAL, useOrder, useServerNow } from './useOrder';

const STEPS: { status: OrderStatus; label: string; hint: string }[] = [
  { status: 'NEW', label: 'Submitted', hint: 'Waiting for the shop to accept' },
  { status: 'ACCEPTED', label: 'Accepted', hint: 'The shop will print it soon' },
  { status: 'PRINTING', label: 'Printing', hint: 'Your pages are being printed' },
  { status: 'PRINTED', label: 'Printed', hint: 'Printing is finished' },
  { status: 'READY', label: 'Ready', hint: 'Collect it from the shop and pay there' },
  { status: 'COLLECTED', label: 'Collected', hint: 'All done. Thank you!' }
];

const fmtTime = (iso?: string) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

function stepTimes(order: TrackedOrder): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const h of (order.statusHistory ?? []) as HistoryEntry[]) {
    const st = h.toStatus ?? h.status; const at = h.at ?? h.createdAt;
    if (st && at && !out[st]) out[st] = at;
  }
  if (!out.NEW && order.createdAt) out.NEW = order.createdAt;
  if (!out[order.status] && order.updatedAt) out[order.status] = order.updatedAt;
  return out;
}

export function TrackingPage() {
  const { id: token = '' } = useParams();
  const { state, skew, refetch } = useOrder(token);
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const order = state.phase === 'ready' ? state.order : null;

  const deleteAt = order?.documentDeleteAfter ? Date.parse(order.documentDeleteAfter) : NaN;
  const hasClock = Number.isFinite(deleteAt);
  const flaggedDeleted = !!order && (order.documentStatus === 'DELETED' || !!order.documentDeletedAt);
  const now = useServerNow(skew, hasClock && !flaggedDeleted);
  const expiredClock = hasClock && now >= deleteAt;
  const deleted = flaggedDeleted || expiredClock;

  const refetched = useRef(false);
  useEffect(() => { if (expiredClock && !flaggedDeleted && !refetched.current) { refetched.current = true; refetch(); } }, [expiredClock, flaggedDeleted, refetch]);
  const loaded = order !== null;
  useEffect(() => { if (loaded) heading.current?.focus(); }, [loaded]);

  if (state.phase === 'loading') return <main className="cx-page" aria-busy="true"><div className="cx-card" role="status" aria-label="Loading order"><Skeleton lines={4} /></div></main>;
  if (state.phase === 'missing') return <NotFound title="Order not found" body="This tracking link isn't valid. Check the link you were given." />;
  if (state.phase === 'error' || !order) {
    return <main className="cx-page"><div className="cx-card cx-center"><Alert>We couldn't load your order. We'll keep trying.</Alert></div></main>;
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopied(false); }
  };
  const slug = order.shopSlug ?? getRecentOrders().find((o) => o.token === token)?.slug;
  const idx = STEPS.findIndex((s) => s.status === order.status);
  const times = stepTimes(order);
  const cancelled = order.status === 'CANCELLED', expired = order.status === 'EXPIRED';
  const afterPrint = idx >= 3;
  const showRetention = hasClock && afterPrint;
  const opts = order.printOptions ? describeOptions(order.printOptions) : null;

  return (
    <main className="cx-page">
      <header className="cx-header">
        <p className="cx-eyebrow">{order.shopName}</p>
        <h1 className="cx-h1" tabIndex={-1} ref={heading}>Order {order.orderNumber}</h1>
        {state.failing && <Alert tone="info">Having trouble updating. Showing the last known status.</Alert>}
      </header>

      {(cancelled || expired) && (
        <div className="cx-card cx-terminal" role="status">
          <h2 className="cx-h2">{cancelled ? 'Order cancelled' : 'Order expired'}</h2>
          <p className="cx-muted">{cancelled ? 'This order was cancelled and will not be printed. Your file is removed. You can place a new order any time.'
            : 'This order was not printed in time, so it expired and your file was removed. You can place a new order any time.'}</p>
        </div>
      )}

      {!cancelled && !expired && (
        <section className="cx-card" aria-labelledby="cx-status-h">
          <h2 className="cx-h2" id="cx-status-h">Status</h2>
          <p className="cx-sr" aria-live="polite">Current status: {STEPS[idx]?.label ?? order.status}</p>
          <ol className="cx-timeline">
            {STEPS.map((s, i) => {
              const cls = i < idx || (order.status === 'COLLECTED' && i === idx) ? 'is-done' : i === idx ? 'is-current' : 'is-todo';
              const t = fmtTime(times[s.status]);
              return (
                <li key={s.status} className={cls} aria-current={i === idx ? 'step' : undefined}>
                  <span className="cx-dot" aria-hidden="true" />
                  <div>
                    <div className="cx-step-label">{s.label}{i === idx && <span className="cx-sr"> (current)</span>}</div>
                    {i === idx && <div className="cx-muted cx-small">{s.hint}</div>}
                    {t && i <= idx && <div className="cx-muted cx-small cx-tnum">{t}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {(showRetention || flaggedDeleted) && (
        <section className={`cx-card cx-retention${deleted ? ' is-deleted' : ''}`} aria-live="polite">
          {deleted
            ? <><h2 className="cx-h2">Your file has been deleted</h2><p className="cx-muted">Your order is still tracked here. No copy of your document is kept.</p></>
            : <><h2 className="cx-h2">Your file will be deleted in <span className="cx-tnum" data-testid="countdown">{formatCountdown(Math.ceil((deleteAt - now) / 1000) * 1000)}</span></h2>
              <p className="cx-muted">Printed files are removed 30 minutes after printing.</p></>}
        </section>
      )}

      <section className="cx-card" aria-labelledby="cx-sum-h">
        <h2 className="cx-h2" id="cx-sum-h">Order details</h2>
        <dl className="cx-breakdown cx-tnum">
          <div><dt>Reference</dt><dd>{order.orderNumber}</dd></div>
          <div><dt>Shop</dt><dd>{order.shopName}</dd></div>
          {opts && <div><dt>Print</dt><dd>{opts.join(' · ')}</dd></div>}
          {order.selectedPageCount != null && <div><dt>Pages</dt><dd>{order.selectedPageCount}</dd></div>}
          <div><dt>Estimated amount</dt><dd><strong>{formatPaise(order.totalPaise)}</strong></dd></div>
        </dl>
        <p className="cx-small">Estimated amount — pay the shop directly when you collect.</p>
      </section>

      <div className="cx-row cx-gap cx-actions">
        <button type="button" className="cx-btn" onClick={() => void copy()}>Copy tracking link</button>
        {slug && <Link className="cx-btn" to={`/p/${encodeURIComponent(slug)}`}>Back to shop</Link>}
        <span className="cx-small cx-muted" role="status">{copied ? 'Link copied' : ''}</span>
      </div>
      {!TERMINAL.includes(order.status) && <p className="cx-small cx-muted">This page updates automatically.</p>}
    </main>
  );
}
