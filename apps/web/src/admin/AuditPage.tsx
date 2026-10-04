import { useState } from 'react';
import { fmtDate, listAuditLogs, type AuditEntry } from '../lib/admin-api';
import { LoadError, LoadMore, Loading, useCursorList } from './ui';

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
          <label className="sh-field"><span>Filter by action (exact, e.g. admin.shop.suspend)</span>
            <input value={action} onChange={(e) => setAction(e.target.value)} spellCheck={false} /></label>
        </div>
      )}
      {list.loading && <Loading label="Loading audit log" />}
      {list.error != null && <LoadError error={list.error} onRetry={list.reload} />}
      {!list.loading && !list.error && list.items.length === 0 && <div className="sh-empty"><p>No audit entries.</p></div>}
      {!list.loading && list.items.length > 0 && (
        <>
          <ul className="ad-list" aria-label="Audit entries">
            {list.items.map((a) => (
              <li key={a.id} className="ad-row" style={{ display: 'block' }}>
                <div><b>{a.action}</b></div>
                <div className="sh-muted">{fmtDate(a.createdAt)}{a.targetType ? ` · ${a.targetType}` : ''}</div>
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
      <h1>Audit log</h1>
      <AuditList />
    </>
  );
}
