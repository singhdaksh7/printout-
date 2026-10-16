import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, inr, listOrders, type AdminOrder } from '../lib/admin-api';
import { Button, EmptyState, OrderStatusChip, Select, type LegacyOrderStatus } from '../ui';
import { LoadError, LoadMore, Loading, useCursorList } from './ui';

const STATUSES = ['NEW', 'ACCEPTED', 'PRINTING', 'PRINTED', 'READY', 'COLLECTED', 'CANCELLED', 'EXPIRED'];
const label = (k: string) => k.charAt(0) + k.slice(1).toLowerCase();

function pagesText(sel: unknown): string {
  const s = sel as { mode?: string; ranges?: { from: number; to: number }[] } | null;
  if (!s || s.mode !== 'ranges' || !s.ranges?.length) return 'All pages';
  return `Pages ${s.ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)).join(', ')}`;
}

function documentState(o: AdminOrder): string {
  if (o.documentStatus === 'DELETED' || o.deletedAt) return `Document deleted${o.deletedAt ? ` (${fmtDate(o.deletedAt)})` : ''}`;
  if ((o.printInitiatedAt ?? o.printedAt) && o.deleteAfter) return `Retained until ${fmtDate(o.deleteAfter)}`;
  if (o.documentStatus === 'AVAILABLE') return 'Document held (not yet printed)';
  return label(o.documentStatus.toLowerCase());
}

/** Safe operational metadata only. There is deliberately no way to open a document from the admin area. */
export function AdminOrderRows({ items, showShop = true }: { items: AdminOrder[]; showShop?: boolean }) {
  return (
    <ul className="ad-list" aria-label="Orders">
      {items.map((o) => (
        <li key={o.id} className="ad-row ad-row--block" data-testid="admin-order">
          <div className="pb-wrap ad-order-head">
            <b className="pb-mono">{o.orderNumber}</b>
            <OrderStatusChip status={o.status as LegacyOrderStatus} size="sm" />
            {showShop && <Link to={`/admin/shops/${o.shopId}`}>{o.shopName}</Link>}
          </div>
          <div className="pb-muted pb-wrap">
            {fmtDate(o.createdAt)}{o.customerDisplayNameOrReference ? ` · ${o.customerDisplayNameOrReference}` : ''} · {inr(o.totalPaise)}
          </div>
          <div className="pb-muted pb-wrap">
            {o.mimeType ?? 'file'} · {o.selectedPageCount ?? o.pageCount ?? '?'}{o.pageCount != null ? `/${o.pageCount}` : ''} pages · {pagesText(o.pageSelection)} ·{' '}
            {o.colourMode === 'colour' ? 'Colour' : 'B&W'} · {o.sides === 'duplex' ? 'Double-sided' : 'Single-sided'} · {o.copies ?? 1} copies · {o.paperSize ?? 'A4'}
          </div>
          <div className="pb-muted pb-wrap">
            Print started: {fmtDate(o.printInitiatedAt ?? o.printedAt)} · {documentState(o)}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function AdminOrdersPage() {
  const [status, setStatus] = useState('');
  const list = useCursorList<AdminOrder>((cursor, signal) => listOrders({ status, cursor, limit: 25 }, signal), [status]);
  return (
    <>
      <div className="pb-pagehead">
        <div>
          <h1 className="pb-h1">Orders</h1>
          <p className="pb-muted pb-pagehead__sub">Operational metadata only. Customer documents are never available to platform administrators.</p>
        </div>
        <Button variant="outline" size="sm" iconStart="refresh-cw" onClick={list.reload}>Refresh</Button>
      </div>
      <div className="ad-filters">
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </Select>
      </div>
      {list.loading && <Loading label="Loading orders" />}
      {list.error != null && <LoadError error={list.error} onRetry={list.reload} />}
      {!list.loading && !list.error && list.items.length === 0 && <EmptyState title="No orders" icon="inbox" />}
      {!list.loading && list.items.length > 0 && (
        <>
          <AdminOrderRows items={list.items} />
          <LoadMore hasMore={list.hasMore} more={list.more} onClick={list.loadMore} error={list.moreError} />
        </>
      )}
    </>
  );
}
