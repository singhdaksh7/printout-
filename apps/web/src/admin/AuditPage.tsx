import { useState } from 'react';
import { fmtDate, listAuditLogs, type AuditEntry } from '../lib/admin-api';
import { Card, Chip, EmptyState, TextField, type ChipTone } from '../ui';
import { LoadError, LoadMore, Loading, useCursorList } from './ui';

/** Labels only for actions the API really writes; anything else falls back to the raw action text so nothing is invented. */
const ACTION_LABELS: Record<string, { label: string; tone: ChipTone }> = {
  'admin.shop.create': { label: 'Shop created', tone: 'ok' },
  'admin.shop.update': { label: 'Shop updated', tone: 'info' },
  'shop.verify': { label: 'Shop verified', tone: 'ok' },
  'shop.unverify': { label: 'Shop unverified', tone: 'warn' },
  'shop.block': { label: 'Shop blocked', tone: 'err' },
  'shop.unblock': { label: 'Shop unblocked', tone: 'ok' },
  'shop.settings.update': { label: 'Settings updated', tone: 'info' },
  'shop.onboarding.created': { label: 'Shop registered', tone: 'ok' },
  'order.transition': { label: 'Order updated', tone: 'info' },
  'order.payment.upi_submitted': { label: 'UPI payment submitted', tone: 'info' },
  'order.payment.refund_recorded': { label: 'Refund recorded', tone: 'warn' },
  'pricing.create': { label: 'Rate added', tone: 'info' },
  'pricing.update': { label: 'Rate updated', tone: 'info' },
  'pricing.delete': { label: 'Rate removed', tone: 'warn' }
};
export function actionChip(action: string): { label: string; tone: ChipTone } {
  return ACTION_LABELS[action] ?? { label: action, tone: action.startsWith('admin.') ? 'orange' : 'neutral' };
}
export function actorLabel(a: Pick<AuditEntry, 'action' | 'actorUserId'>): string {
  if (a.action.startsWith('admin.') || /^shop\.(verify|unverify|block|unblock)$/.test(a.action)) return 'Admin';
  return a.actorUserId ? 'Shop owner' : 'System';
}
const humanize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).replace(/[_-]/g, ' ');

/** Metadata is shown as the server returned it (admin audit entries hold ids and field names only). */
function Meta({ value }: { value: unknown }) {
  if (value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)) return null;
  return (
    <details>
      <summary>Details</summary>
      <pre className="ad-pre">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function AuditList({ shopId, pageSize = 25 }: { shopId?: string; pageSize?: number }) {
  const [action, setAction] = useState('');
  const list = useCursorList<AuditEntry>(
    (cursor, signal) => listAuditLogs({ ...(shopId ? { shopId } : {}), action: action.trim(), cursor, limit: pageSize }, signal),
    [shopId, action]
  );
  return (
    <>
      {!shopId && (
        <div className="ad-filters">
          <TextField label="Filter by action (exact, e.g. admin.shop.suspend)" value={action} onChange={(e) => setAction(e.target.value)} spellCheck={false} />
        </div>
      )}
      {list.loading && <Loading label="Loading audit log" />}
      {list.error != null && <LoadError error={list.error} onRetry={list.reload} />}
      {!list.loading && !list.error && list.items.length === 0 && <EmptyState icon="scroll-text" title="No audit entries" />}
      {!list.loading && list.items.length > 0 && (
        <>
          <ul className="ad-list" aria-label="Audit entries">
            {list.items.map((a) => (
              <li key={a.id} className="ad-row ad-row--block">
                <div className="ad-chips" data-testid="audit-chips">
                  <Chip tone={actionChip(a.action).tone} size="sm" title={a.action}>{actionChip(a.action).label}</Chip>
                  <Chip tone="neutral" size="sm" dot={false}>{actorLabel(a)}</Chip>
                  {a.targetType && <Chip tone="neutral" size="sm" dot={false}>{humanize(a.targetType)}</Chip>}
                </div>
                <time className="pb-muted" dateTime={a.createdAt}>{fmtDate(a.createdAt)}</time>
                <Meta value={a.metadata} />
              </li>
            ))}
          </ul>
          <LoadMore hasMore={list.hasMore} more={list.more} onClick={list.loadMore} error={list.moreError} />
        </>
      )}
    </>
  );
}

export default function AuditPage() {
  return (
    <>
      <h1 className="pb-h1">Audit log</h1>
      <Card><AuditList /></Card>
    </>
  );
}
