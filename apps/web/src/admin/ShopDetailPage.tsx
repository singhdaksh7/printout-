import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  SUB_STATUSES, deleteShop, fmtDate, getShop, inr, listPlans, updateShop, updateSubscription, verifyShop,
  type ShopDetail, type ShopStatus, type SubStatus
} from '../lib/admin-api';
import { ApiError } from '../lib/api';
import { Banner, Button, Card, CardHeader, Checkbox, Chip, KeyValueList, Modal, StatTile, ShopStatusChip, TextField, buttonClass, useToast } from '../ui';
import { AuditList } from './AuditPage';
import { AdminOrderRows } from './OrdersPage';
import { LoadError, Loading, MANUAL_NOTE, adminError, useLoad } from './ui';
import { PasswordField } from './account-parts';

function StatusCard({ d, onChanged }: { d: ShopDetail; onChanged: (msg: string) => void }) {
  const [confirm, setConfirm] = useState<ShopStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const suspended = d.shop.status === 'SUSPENDED';
  const target: ShopStatus = suspended ? 'ACTIVE' : 'SUSPENDED';

  async function apply() {
    setBusy(true);
    setErr(null);
    try {
      await updateShop(d.shop.id, { status: target });
      setConfirm(null);
      onChanged(target === 'SUSPENDED' ? 'Shop suspended' : 'Shop activated');
    } catch (e) { setErr(adminError(e)); }
    setBusy(false);
  }
  return (
    <Card as="section" aria-labelledby="st-h">
      <CardHeader id="st-h" title="Shop status" />
      <p>Currently <ShopStatusChip status={d.shop.status} size="sm" /></p>
      <div className="ad-actions">
        <Button variant={suspended ? 'primary' : 'danger'} onClick={() => { setErr(null); setConfirm(target); }}>
          {suspended ? 'Activate shop' : 'Suspend shop'}
        </Button>
      </div>
      {confirm && (
        <Modal
          title={confirm === 'SUSPENDED' ? `Suspend ${d.shop.displayName}?` : `Activate ${d.shop.displayName}?`}
          tone={confirm === 'SUSPENDED' ? 'danger' : 'default'}
          onClose={() => setConfirm(null)}
          busy={busy}
          footer={<>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
            <Button variant={confirm === 'SUSPENDED' ? 'danger' : 'primary'} onClick={apply} disabled={busy} loading={busy}>
              {busy ? 'Working…' : confirm === 'SUSPENDED' ? 'Yes, suspend' : 'Yes, activate'}
            </Button>
          </>}
        >
          {confirm === 'SUSPENDED' ? (
            <p>The shop will stop accepting new customer orders and every signed-in session of its staff is ended immediately. Existing data is kept. You can activate it again at any time.</p>
          ) : (
            <p>The shop will be able to sign in and accept customer orders again.</p>
          )}
          {err && <Banner tone="err">{err}</Banner>}
        </Modal>
      )}
    </Card>
  );
}

/** Whether the shop has been checked by the platform. Until it has, its owner cannot open it and customers cannot find it. */
function VerificationCard({ d, onChanged }: { d: ShopDetail; onChanged: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const verified = d.shop.isVerified === true;

  async function toggle() {
    setBusy(true);
    setErr(null);
    try {
      await verifyShop(d.shop.id, !verified);
      onChanged(verified ? 'Shop unverified' : 'Shop verified');
    } catch (e) { setErr(adminError(e)); }
    setBusy(false);
  }
  return (
    <Card as="section" aria-labelledby="vf-h">
      <CardHeader id="vf-h" title="Verification" />
      <p>
        {verified
          ? <>Verified {d.shop.verifiedAt ? `on ${fmtDate(d.shop.verifiedAt)}` : ''}. Customers can find this shop and its owner can open it.</>
          : 'Not verified yet. Customers cannot find this shop and its owner cannot open it until you verify it.'}
      </p>
      {err && <Banner tone="err">{err}</Banner>}
      <div className="ad-actions">
        <Button variant={verified ? 'outline' : 'primary'} onClick={toggle} disabled={busy} loading={busy}>
          {busy ? 'Working…' : verified ? 'Remove verification' : 'Verify shop'}
        </Button>
      </div>
    </Card>
  );
}

const IN_PROGRESS = ['NEW', 'ACCEPTED', 'PRINTING'] as const;

export function DangerZone({ d }: { d: ShopDetail }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [password, setPassword] = useState('');
  const [force, setForce] = useState(false);
  const [serverBlocked, setServerBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inProgress = IN_PROGRESS.reduce((n, k) => n + (d.ordersByStatus[k] ?? 0), 0);
  const needsForce = inProgress > 0 || serverBlocked;
  const ready = slug === d.shop.slug && password.length > 0 && (!needsForce || force);

  function close() {
    if (busy) return;
    setOpen(false); setSlug(''); setPassword(''); setForce(false); setErr(null);
  }
  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteShop(d.shop.id, { confirmSlug: slug, currentPassword: password, ...(force ? { force: true } : {}) });
      navigate('/admin/shops', { state: { toast: `Deleted ${d.shop.displayName}` } });
      return;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SHOP_HAS_ACTIVE_WORK') {
        setServerBlocked(true);
        setErr('This shop has orders or print jobs in progress. Tick the box below to delete it anyway.');
      } else if (e instanceof ApiError && e.code === 'INVALID_CURRENT_PASSWORD') {
        setErr('Your admin password is incorrect.');
      } else if (e instanceof ApiError && e.code === 'SHOP_SLUG_MISMATCH') {
        setErr('The typed slug does not match this shop.');
      } else {
        setErr(adminError(e));
      }
    }
    setBusy(false);
  }
  return (
    <Card as="section" aria-labelledby="dz-h">
      <CardHeader id="dz-h" title="Danger zone" />
      <p>Permanently deletes this shop, its orders, files, devices and the owner login. This cannot be undone.</p>
      <div className="ad-actions">
        <Button variant="danger" onClick={() => setOpen(true)}>Delete shop…</Button>
      </div>
      {open && (
        <Modal
          title={`Delete ${d.shop.displayName}?`}
          tone="danger"
          onClose={close}
          busy={busy}
          footer={<>
            <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="danger" onClick={submit} disabled={!ready || busy} loading={busy}>
              {busy ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </>}
        >
          <p>All orders, uploaded files, devices, settings and the owner account of this shop will be removed. Customer accounts are kept.</p>
          <TextField label={`Type the shop slug (${d.shop.slug}) to confirm`} value={slug} onChange={(e) => setSlug(e.target.value)} autoComplete="off" disabled={busy} />
          <PasswordField label="Your admin password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={busy} />
          {needsForce && (
            <Checkbox
              label="Also delete shop with active orders"
              hint={inProgress > 0 ? `${inProgress} order${inProgress === 1 ? ' is' : 's are'} still new, accepted or printing.` : 'Print jobs are still in progress.'}
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              disabled={busy}
            />
          )}
          {err && <Banner tone="err">{err}</Banner>}
        </Modal>
      )}
    </Card>
  );
}

const toDateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');


/** Who the shop is and whether it can trade, with the one action that is usually wanted first: verifying it. */
function Hero({ d, onChanged }: { d: ShopDetail; onChanged: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const verified = d.shop.isVerified === true;
  const owner = d.owners[0];

  async function verify() {
    setBusy(true);
    setErr(null);
    try {
      await verifyShop(d.shop.id, true);
      onChanged('Shop verified');
    } catch (e) { setErr(adminError(e)); }
    setBusy(false);
  }
  return (
    <Card as="section" aria-labelledby="hero-h" className="ad-hero">
      <div className="ad-hero__main">
        <div>
          <h1 id="hero-h" className="pb-h1 pb-wrap">{d.shop.displayName}</h1>
          <div className="pb-muted pb-mono">/{d.shop.slug}</div>
        </div>
        <div className="ad-hero__chips">
          <ShopStatusChip status={d.shop.status} size="sm" />
          <Chip tone={verified ? 'ok' : 'warn'} size="sm">{verified ? 'Verified' : 'Not verified'}</Chip>
          <Chip tone={d.shop.acceptsOrders ? 'ok' : 'neutral'} size="sm">{d.shop.acceptsOrders ? 'Taking orders' : 'Not taking orders'}</Chip>
        </div>
      </div>
      <dl className="ad-hero__facts">
        <div><dt>Owner</dt><dd className="pb-wrap">{owner ? <>{owner.displayName} · <a href={`mailto:${owner.email}`}>{owner.email}</a></> : '—'}</dd></div>
        <div><dt>Address</dt><dd>{d.shop.address || '—'}</dd></div>
        <div><dt>Registered</dt><dd>{fmtDate(d.shop.createdAt)}</dd></div>
      </dl>
      {!verified && (
        <div className="ad-hero__cta">
          <p className="pb-muted">This shop is waiting for you. Until it is verified its owner cannot open it and customers cannot find it.</p>
          <Button variant="primary" onClick={verify} disabled={busy} loading={busy}>{busy ? 'Verifying…' : 'Verify shop'}</Button>
        </div>
      )}
      {err && <Banner tone="err">{err}</Banner>}
    </Card>
  );
}

const statusLabel = (k: string) => k.charAt(0) + k.slice(1).toLowerCase();

export default function ShopDetailPage() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad((s) => getShop(id, s), [id]);
  const toast = useToast();
  const changed = (m: string) => { toast.show(m); reload(); };
  const byStatus = data ? Object.entries(data.ordersByStatus).filter(([, v]) => v > 0) : [];
  return (
    <>
      <Link className={buttonClass({ variant: 'ghost', size: 'sm', className: 'pb-back' })} to="/admin/shops">← Shops</Link>
      {loading && !data && <Loading label="Loading shop" />}
      {error != null && <LoadError error={error} onRetry={reload} />}
      {data && (
        <>
          <Hero d={data} onChanged={changed} />

          <section aria-label="Shop activity" className="pb-stats">
            <StatTile label="Total orders" value={data.usage.orderCount} />
            <StatTile label="Last 30 days" value={data.usage.ordersLast30Days} />
            <StatTile label="Pricing rules" value={data.usage.pricingRuleCount} />
            <StatTile label="Last order" value={data.usage.lastOrderAt ? fmtDate(data.usage.lastOrderAt) : '—'} />
          </section>

          <div className="ad-grid">
            <Card as="section" aria-labelledby="pr-h">
              <CardHeader id="pr-h" title="Pricing (read only)" />
              {data.pricingRules.length === 0 ? <p className="pb-muted">No pricing rules configured.</p> : (
                <KeyValueList items={data.pricingRules.map((r) => ({
                  label: `${r.colourMode === 'colour' ? 'Colour' : 'B&W'} · ${r.sides === 'duplex' ? 'Double-sided' : 'Single-sided'} · ${r.paperSize}${r.active ? '' : ' (inactive)'}`,
                  value: `${inr(r.pricePerSheetPaise)} / sheet`
                }))} layout="stacked" />
              )}
            </Card>
            <Card as="section" aria-labelledby="os-h">
              <CardHeader id="os-h" title="Orders by status" />
              {byStatus.length === 0 ? <p className="pb-muted">No orders yet.</p> : (
                <ul className="ad-chips" aria-label="Orders by status">
                  {byStatus.map(([k, v]) => <li key={k}><Chip tone="neutral">{statusLabel(k)}: <strong>{v}</strong></Chip></li>)}
                </ul>
              )}
            </Card>
          </div>

          <Card as="section" aria-labelledby="ro-h">
            <CardHeader id="ro-h" title="Recent orders" />
            {data.recentOrders.length === 0 ? <p className="pb-muted">No orders yet.</p> : <AdminOrderRows items={data.recentOrders} showShop={false} />}
            <p className="pb-muted">Operational metadata only. Customer documents are not accessible to platform administrators.</p>
          </Card>

          <Card as="section" aria-labelledby="aud-h">
            <CardHeader id="aud-h" title="Recent audit entries" />
            <AuditList shopId={data.shop.id} pageSize={10} />
          </Card>

          <h2 className="pb-h2 ad-manage">Manage shop</h2>
          <div className="ad-grid">
            <VerificationCard d={data} onChanged={changed} />
            <StatusCard d={data} onChanged={changed} />
          </div>
          <DangerZone d={data} />
        </>
      )}
      {toast.node}
    </>
  );
}
