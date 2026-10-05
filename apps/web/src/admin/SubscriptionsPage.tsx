import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SUB_STATUSES, fmtDate, inr, listSubscriptions, type SubStatus, type SubscriptionRow } from '../lib/admin-api';
import { Banner } from '../shop/components';
import { Field, LoadError, LoadMore, Loading, MANUAL_NOTE, ShopStatusChip, useCursorList } from './ui';

const label = (k: string) => k.charAt(0) + k.slice(1).toLowerCase();

/** Overview only: activate / extend / suspend / reactivate happen on each shop's page (PUT /admin/subscriptions/{shopId}). */
export default function SubscriptionsPage() {
  const [status, setStatus] = useState<SubStatus | ''>('');
  const list = useCursorList<SubscriptionRow>((cursor, signal) => listSubscriptions({ status, cursor, limit: 25 }, signal), [status]);
  return (
    <>
      <div className="sh-pagehead"><h1>Subscriptions</h1></div>
      <Banner kind="info">{MANUAL_NOTE}</Banner>
      <div className="ad-filters">
        <Field label="Status">
          <select className="ad-select" value={status} onChange={(e) => setStatus(e.target.value as SubStatus | '')}>
            <option value="">All</option>
            {SUB_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </Field>
      </div>
      {list.loading && <Loading label="Loading subscriptions" />}
      {list.error != null && <LoadError error={list.error} onRetry={list.reload} />}
      {!list.loading && !list.error && list.items.length === 0 && <div className="sh-empty"><h2>No subscriptions</h2></div>}
      {!list.loading && list.items.length > 0 && (
        <>
          <ul className="ad-list" aria-label="Subscriptions">
            {list.items.map((s) => (
              <li key={s.id} className="ad-row">
                <div>
                  <Link to={`/admin/shops/${s.shopId}`}>{s.shop.displayName}</Link>
                  <div className="sh-muted">/{s.shop.slug} · {s.plan.name} ({inr(s.plan.pricePaise)}/month)</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className="sh-chip sh-chip-printed">{label(s.status)}</span>
                  <div className="sh-muted">Renews {fmtDate(s.renewsAt)}</div>
                  <div className="sh-muted">Shop <ShopStatusChip status={s.shop.status} /></div>
                </div>
              </li>
            ))}
          </ul>
          <LoadMore hasMore={list.hasMore} more={list.more} onClick={list.loadMore} error={list.moreError} />
        </>
      )}
    </>
  );
}
