import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  SUB_STATUSES, deleteShop, fmtDate, getShop, inr, listPlans, updateShop, updateSubscription,
  type ShopDetail, type ShopStatus, type SubStatus
} from '../lib/admin-api';
import { ApiError } from '../lib/api';
import { Banner, Button, Card, CardHeader, Checkbox, KeyValueList, Modal, Select, ShopStatusChip, TextField, buttonClass, useToast } from '../ui';
import { AuditList } from './AuditPage';
import { AdminOrderRows } from './OrdersPage';
import { LoadError, Loading, MANUAL_NOTE, adminError, useLoad } from './ui';

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
          <TextField label="Your admin password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={busy} />
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


export default function ShopDetailPage() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad((s) => getShop(id, s), [id]);
  const toast = useToast();
  const changed = (m: string) => { toast.show(m); reload(); };
  return (
    <>
      <Link className={buttonClass({ variant: 'ghost', size: 'sm', className: 'pb-back' })} to="/admin/shops">← Shops</Link>
      {loading && !data && <Loading label="Loading shop" />}
      {error != null && <LoadError error={error} onRetry={reload} />}
      {data && (
        <>
          <h1 className="pb-h1 pb-wrap">{data.shop.displayName}</h1>
          <div className="ad-grid">
            <Card as="section" aria-labelledby="meta-h">
              <CardHeader id="meta-h" title="Details" />
              <KeyValueList items={[
                { label: 'Slug', value: `/${data.shop.slug}`, mono: true },
                { label: 'Address', value: data.shop.address || '—' },
                { label: 'Accepting orders', value: data.shop.acceptsOrders ? 'Yes' : 'No' },
                { label: 'Created', value: fmtDate(data.shop.createdAt) },
                ...data.owners.map((o) => ({ label: 'Owner', value: <span className="pb-wrap">{o.displayName} · {o.email}</span> }))
              ]} layout="stacked" />
            </Card>
            <Card as="section" aria-labelledby="use-h">
              <CardHeader id="use-h" title="Usage" />
              <KeyValueList items={[
                { label: 'Total orders', value: data.usage.orderCount },
                { label: 'Orders, last 30 days', value: data.usage.ordersLast30Days },
                { label: 'Pricing rules', value: data.usage.pricingRuleCount },
                { label: 'Last order', value: fmtDate(data.usage.lastOrderAt) }
              ]} />
            </Card>
            <Card as="section" aria-labelledby="os-h">
              <CardHeader id="os-h" title="Orders by status" />
              <KeyValueList items={Object.entries(data.ordersByStatus).map(([k, v]) => ({ label: k.charAt(0) + k.slice(1).toLowerCase(), value: v }))} />
            </Card>
            <Card as="section" aria-labelledby="pr-h">
              <CardHeader id="pr-h" title="Pricing (read only)" />
              {data.pricingRules.length === 0 ? <p className="pb-muted">No pricing rules configured.</p> : (
                <KeyValueList items={data.pricingRules.map((r) => ({
                  label: `${r.colourMode === 'colour' ? 'Colour' : 'B&W'} · ${r.sides === 'duplex' ? 'Double-sided' : 'Single-sided'} · ${r.paperSize}${r.active ? '' : ' (inactive)'}`,
                  value: `${inr(r.pricePerSheetPaise)} / sheet`
                }))} layout="stacked" />
              )}
            </Card>
          </div>
          <Card as="section" aria-labelledby="ro-h">
            <CardHeader id="ro-h" title="Recent orders" />
            {data.recentOrders.length === 0 ? <p className="pb-muted">No orders yet.</p> : <AdminOrderRows items={data.recentOrders} showShop={false} />}
            <p className="pb-muted">Operational metadata only. Customer documents are not accessible to platform administrators.</p>
          </Card>
          <StatusCard d={data} onChanged={changed} />
          <Card as="section" aria-labelledby="aud-h">
            <CardHeader id="aud-h" title="Recent audit entries" />
            <AuditList shopId={data.shop.id} pageSize={10} />
          </Card>
          <DangerZone d={data} />
        </>
      )}
      {toast.node}
    </>
  );
}
