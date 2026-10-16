import { Link } from 'react-router-dom';
import { fmtDate, getDashboard } from '../lib/admin-api';
import { Button, Card, CardHeader, KeyValueList, StatTile } from '../ui';
import { AdminOrderRows } from './OrdersPage';
import { LoadError, Loading, useLoad } from './ui';

const label = (k: string) => k.charAt(0) + k.slice(1).toLowerCase();
const counts = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => ({ label: label(k), value: v }));

export default function DashboardPage() {
  const { data, error, loading, reload } = useLoad((s) => getDashboard(s), []);
  return (
    <>
      <div className="pb-pagehead">
        <h1 className="pb-h1">Dashboard</h1>
        <Button variant="outline" size="sm" iconStart="refresh-cw" onClick={reload}>Refresh</Button>
      </div>
      {loading && !data && <Loading label="Loading dashboard" />}
      {error != null && <LoadError error={error} onRetry={reload} />}
      {data && (
        <>
          <section aria-label="Platform totals" className="pb-stats">
            <StatTile label="Shops" value={data.totalShops} />
            <StatTile label="Active subscriptions" value={data.activeSubscriptions} />
            <StatTile label="Orders today (all shops)" value={data.ordersToday} />
            <StatTile label="Total orders" value={data.totalOrders} />
            <StatTile label="Total pages (non-cancelled)" value={data.totalPages} />
          </section>
          <div className="ad-grid">
            <Card as="section" aria-labelledby="d-orders">
              <CardHeader id="d-orders" title="Orders by status" />
              <KeyValueList items={counts(data.ordersByStatus).map((c) => ({ label: c.label, value: c.value }))} />
            </Card>
            <Card as="section" aria-labelledby="d-shops">
              <CardHeader id="d-shops" title="Shops by status" />
              <KeyValueList items={counts(data.shopsByStatus).map((c) => ({ label: c.label, value: c.value }))} />
            </Card>
            <Card as="section" aria-labelledby="d-subs">
              <CardHeader id="d-subs" title="Subscriptions by status" />
              <KeyValueList items={counts(data.subscriptionsByStatus).map((c) => ({ label: c.label, value: c.value }))} />
            </Card>
          </div>
          <Card as="section" aria-labelledby="d-rs">
            <CardHeader id="d-rs" title="Recent shops" />
            <ul className="ad-list" aria-label="Recent shops">
              {data.recentShops.map((s) => (
                <li key={s.id} className="ad-row">
                  <div><Link to={`/admin/shops/${s.id}`}>{s.displayName}</Link><div className="pb-muted">/{s.slug}</div></div>
                  <div className="pb-muted ad-right">{fmtDate(s.createdAt)}</div>
                </li>
              ))}
            </ul>
          </Card>
          <Card as="section" aria-labelledby="d-ro">
            <CardHeader id="d-ro" title="Recent orders" actions={<Link to="/admin/orders">All orders</Link>} />
            {data.recentOrders.length === 0 ? <p className="pb-muted">No orders yet.</p> : <AdminOrderRows items={data.recentOrders} />}
          </Card>
          <p className="pb-muted">Orders today are counted in {data.timezone}. Counts only; no customer documents are shown here.</p>
        </>
      )}
    </>
  );
}
