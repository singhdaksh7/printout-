import { Link } from 'react-router-dom';
import { fmtDate, getDashboard, type AdminShop, type Dashboard } from '../lib/admin-api';
import { BarChart, Button, Card, CardHeader, Chip, StatTile, buttonClass } from '../ui';
import { AdminOrderRows } from './OrdersPage';
import { LoadError, Loading, useLoad } from './ui';

const label = (k: string) => (k.charAt(0) + k.slice(1).toLowerCase()).replace(/_/g, ' ');
const counts = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => ({ label: label(k), value: v }));

/** Orders the shop still has to do something about; the same three the shop app's "open" tabs show. */
const IN_PROGRESS = ['NEW', 'ACCEPTED', 'PRINTING'] as const;

const weekday = (isoDay: string) => new Date(`${isoDay}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' });

/** Orders by status, only the statuses that have any: a row of zeros says nothing, and what the shops are doing with them is the shops' business. */
function OrderBreakdown({ byStatus }: { byStatus: Record<string, number> }) {
  const present = counts(byStatus).filter((c) => c.value > 0);
  if (present.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="d-orders">
      <CardHeader id="d-orders" title="Orders by status" />
      <ul className="ad-chips" aria-label="Orders by status">
        {present.map((c) => <li key={c.label}><Chip tone="neutral">{c.label}: <strong>{c.value}</strong></Chip></li>)}
      </ul>
    </Card>
  );
}

/** The things an admin has to act on, first: a dashboard that only counts leaves them to go looking. */
function Attention({ data }: { data: Dashboard }) {
  const inProgress = IN_PROGRESS.reduce((n, k) => n + (data.ordersByStatus[k] ?? 0), 0);
  const suspended = data.shopsByStatus.SUSPENDED ?? 0;
  const nothing = data.pendingVerification === 0 && suspended === 0 && inProgress === 0;

  return (
    <Card as="section" aria-labelledby="d-attn">
      <CardHeader
        id="d-attn"
        title="Needs your attention"
        actions={data.pendingVerification > 0 ? <Link className={buttonClass({ variant: 'outline', size: 'sm' })} to="/admin/shops?verified=false">See all unverified</Link> : undefined}
      />
      {nothing && <p className="pb-muted">Nothing is waiting. New shops, suspended shops and orders in progress appear here.</p>}

      {data.pendingVerification > 0 && (
        <>
          <p>
            <strong>{data.pendingVerification}</strong> {data.pendingVerification === 1 ? 'shop is' : 'shops are'} waiting to be verified. Until then the owner cannot open the shop and customers cannot find it.
          </p>
          <ul className="ad-list" aria-label="Shops waiting for verification">
            {data.awaitingVerification.map((s: AdminShop) => (
              <li key={s.id} className="ad-row">
                <div>
                  <Link to={`/admin/shops/${s.id}`}>{s.displayName}</Link>
                  <div className="pb-muted pb-wrap">{s.owner ? `${s.owner.displayName} · ${s.owner.email}` : `/${s.slug}`}</div>
                </div>
                <div className="ad-right">
                  <Chip tone="warn" size="sm">Not verified</Chip>
                  <div className="pb-muted">Registered {fmtDate(s.createdAt)}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {(suspended > 0 || inProgress > 0) && (
        <ul className="ad-list" aria-label="Other items">
          {suspended > 0 && (
            <li className="ad-row">
              <div><strong>{suspended}</strong> suspended {suspended === 1 ? 'shop' : 'shops'}</div>
              <Link to="/admin/shops?status=SUSPENDED">Review</Link>
            </li>
          )}
          {inProgress > 0 && (
            <li className="ad-row">
              <div><strong>{inProgress}</strong> {inProgress === 1 ? 'order' : 'orders'} in progress across all shops</div>
              <Link to="/admin/orders">View orders</Link>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

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
          <Attention data={data} />

          <section aria-label="Platform totals" className="pb-stats">
            <StatTile label="Shops" value={data.totalShops} hint={`${data.shopsByStatus.ACTIVE ?? 0} active`} />
            <StatTile label="Open now" value={data.openShops} hint="Active shops taking orders" />
            <StatTile label="Orders today (all shops)" value={data.ordersToday} />
            <StatTile label="Total orders" value={data.totalOrders} />
            <StatTile label="Total pages (non-cancelled)" value={data.totalPages} />
          </section>

          <Card as="section" aria-labelledby="d-week">
            <CardHeader id="d-week" title="Orders in the last 7 days" />
            <BarChart
              title="Orders per day, last 7 days"
              summary={`${data.ordersLast7Days.reduce((n, d) => n + d.count, 0)} orders in the last 7 days`}
              valueName="Orders"
              height={200}
              data={data.ordersLast7Days.map((d, i) => ({
                label: weekday(d.date),
                value: d.count,
                // Today is still going, so it is drawn lighter than the finished days.
                tone: i === data.ordersLast7Days.length - 1 ? ('muted' as const) : ('default' as const),
                tooltip: `${d.date}: ${d.count} ${d.count === 1 ? 'order' : 'orders'}`
              }))}
            />
          </Card>

          <OrderBreakdown byStatus={data.ordersByStatus} />

          <Card as="section" aria-labelledby="d-rs">
            <CardHeader id="d-rs" title="Recent shops" actions={<Link to="/admin/shops">All shops</Link>} />
            <ul className="ad-list" aria-label="Recent shops">
              {data.recentShops.map((s) => (
                <li key={s.id} className="ad-row">
                  <div><Link to={`/admin/shops/${s.id}`}>{s.displayName}</Link><div className="pb-muted">/{s.slug}</div></div>
                  <div className="ad-right">
                    <Chip tone={s.isVerified ? 'ok' : 'warn'} size="sm">{s.isVerified ? 'Verified' : 'Not verified'}</Chip>
                    <div className="pb-muted">{fmtDate(s.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Card as="section" aria-labelledby="d-ro">
            <CardHeader id="d-ro" title="Recent orders" actions={<Link to="/admin/orders">All orders</Link>} />
            {data.recentOrders.length === 0 ? <p className="pb-muted">No orders yet.</p> : <AdminOrderRows items={data.recentOrders} />}
          </Card>
          <p className="pb-muted">Orders today and the 7-day chart use {data.timezone} days. Counts only; no customer documents are shown here.</p>
        </>
      )}
    </>
  );
}
