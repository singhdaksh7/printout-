import { Link } from 'react-router-dom';
import { fmtDate, getDashboard } from '../lib/admin-api';
import { AdminOrderRows } from './OrdersPage';
import { LoadError, Loading, useLoad } from './ui';

const label = (k: string) => k.charAt(0) + k.slice(1).toLowerCase();

export default function DashboardPage() {
  const { data, error, loading, reload } = useLoad((s) => getDashboard(s), []);
  return (
    <>
      <div className="sh-pagehead"><h1>Dashboard</h1><button className="sh-btn sh-btn-sm" onClick={reload}>Refresh</button></div>
      {loading && !data && <Loading label="Loading dashboard" />}
      {error != null && <LoadError error={error} onRetry={reload} />}
      {data && (
        <>
          <section aria-label="Platform totals" className="ad-stats">
            <div className="ad-stat"><span className="sh-muted">Shops</span><b>{data.totalShops}</b></div>
            <div className="ad-stat"><span className="sh-muted">Active subscriptions</span><b>{data.activeSubscriptions}</b></div>
            <div className="ad-stat"><span className="sh-muted">Orders today (all shops)</span><b>{data.ordersToday}</b></div>
            <div className="ad-stat"><span className="sh-muted">Total orders</span><b>{data.totalOrders}</b></div>
            <div className="ad-stat"><span className="sh-muted">Total pages (non-cancelled)</span><b>{data.totalPages}</b></div>
          </section>
          <section className="sh-card" aria-labelledby="d-orders">
            <h2 id="d-orders">Orders by status</h2>
            <dl className="sh-dl">{Object.entries(data.ordersByStatus).map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{v}</dd></div>)}</dl>
          </section>
          <section className="sh-card" aria-labelledby="d-rs">
            <h2 id="d-rs">Recent shops</h2>
            <ul className="ad-list" aria-label="Recent shops">
              {data.recentShops.map((s) => (
                <li key={s.id} className="ad-row">
                  <div><Link to={`/admin/shops/${s.id}`}>{s.displayName}</Link><div className="sh-muted">/{s.slug}</div></div>
                  <div className="sh-muted" style={{ textAlign: 'right' }}>{fmtDate(s.createdAt)}</div>
                </li>
              ))}
            </ul>
          </section>
          <section className="sh-card" aria-labelledby="d-ro">
            <h2 id="d-ro">Recent orders</h2>
            {data.recentOrders.length === 0 ? <p className="sh-muted">No orders yet.</p> : <AdminOrderRows items={data.recentOrders} />}
            <p><Link to="/admin/orders">All orders</Link></p>
          </section>
          <section className="sh-card" aria-labelledby="d-shops">
            <h2 id="d-shops">Shops by status</h2>
            <dl className="sh-dl">{Object.entries(data.shopsByStatus).map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{v}</dd></div>)}</dl>
          </section>
          <section className="sh-card" aria-labelledby="d-subs">
            <h2 id="d-subs">Subscriptions by status</h2>
            <dl className="sh-dl">{Object.entries(data.subscriptionsByStatus).map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{v}</dd></div>)}</dl>
          </section>
          <p className="sh-muted">Orders today are counted in {data.timezone}. Counts only; no customer documents are shown here.</p>
        </>
      )}
    </>
  );
}
