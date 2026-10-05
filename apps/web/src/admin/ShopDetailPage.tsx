import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  SUB_STATUSES, fmtDate, getShop, inr, listPlans, updateShop, updateSubscription,
  type ShopDetail, type ShopStatus, type SubStatus
} from '../lib/admin-api';
import { Banner, Modal, useToast } from '../shop/components';
import { AuditList } from './AuditPage';
import { AdminOrderRows } from './OrdersPage';
import { Field, LoadError, Loading, MANUAL_NOTE, ShopStatusChip, adminError, useLoad } from './ui';

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
    <section className="sh-card" aria-labelledby="st-h">
      <h2 id="st-h">Shop status</h2>
      <p>Currently <ShopStatusChip status={d.shop.status} /></p>
      <div className="sh-actions">
        <button className={`sh-btn ${suspended ? 'sh-btn-primary' : 'sh-btn-danger'}`} onClick={() => { setErr(null); setConfirm(target); }}>
          {suspended ? 'Activate shop' : 'Suspend shop'}
        </button>
      </div>
      {confirm && (
        <Modal title={confirm === 'SUSPENDED' ? `Suspend ${d.shop.displayName}?` : `Activate ${d.shop.displayName}?`} onClose={() => setConfirm(null)} busy={busy}>
          {confirm === 'SUSPENDED' ? (
            <p>The shop will stop accepting new customer orders and every signed-in session of its staff is ended immediately. Existing data is kept. You can activate it again at any time.</p>
          ) : (
            <p>The shop will be able to sign in and accept customer orders again.</p>
          )}
          {err && <Banner kind="error">{err}</Banner>}
          <div className="sh-actions">
            <button className="sh-btn" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
            <button className={`sh-btn ${confirm === 'SUSPENDED' ? 'sh-btn-danger' : 'sh-btn-primary'}`} onClick={apply} disabled={busy}>
              {busy ? 'Working…' : confirm === 'SUSPENDED' ? 'Yes, suspend' : 'Yes, activate'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

const toDateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

function SubscriptionCard({ d, onChanged }: { d: ShopDetail; onChanged: (msg: string) => void }) {
  const sub = d.subscription;
  const plans = useLoad((s) => listPlans(s), []);
  const [planId, setPlanId] = useState(sub?.plan.id ?? '');
  const [status, setStatus] = useState<SubStatus>(sub?.status ?? 'ACTIVE');
  const [renews, setRenews] = useState(toDateInput(sub?.renewsAt));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needsPlan = !sub && !planId;

  async function save() {
    if (needsPlan) { setErr('Choose a plan to create the subscription.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await updateSubscription(d.shop.id, {
        status,
        ...(planId ? { planId } : {}),
        renewsAt: renews ? new Date(`${renews}T00:00:00.000Z`).toISOString() : null
      });
      onChanged('Subscription saved');
    } catch (e) { setErr(adminError(e)); }
    setBusy(false);
  }
  return (
    <section className="sh-card" aria-labelledby="sub-h">
      <h2 id="sub-h">Plan and subscription</h2>
      <Banner kind="info">{MANUAL_NOTE}</Banner>
      <dl className="sh-dl">
        <div><dt>Plan</dt><dd>{sub ? `${sub.plan.name} (${inr(sub.plan.pricePaise)}/month)` : 'None'}</dd></div>
        <div><dt>Subscription</dt><dd>{sub ? sub.status.charAt(0) + sub.status.slice(1).toLowerCase() : 'None'}</dd></div>
        <div><dt>Renewal date</dt><dd>{fmtDate(sub?.renewsAt)}</dd></div>
      </dl>
      {err && <Banner kind="error">{err}</Banner>}
      {plans.error != null && <LoadError error={plans.error} onRetry={plans.reload} />}
      <Field label="Plan">
        <select className="ad-select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
          {!sub && <option value="">Select a plan</option>}
          {(plans.data ?? []).filter((p) => p.active || p.id === sub?.plan.id).map((p) => <option key={p.id} value={p.id}>{p.name} — {inr(p.pricePaise)}/month</option>)}
        </select>
      </Field>
      <Field label="Subscription status">
        <select className="ad-select" value={status} onChange={(e) => setStatus(e.target.value as SubStatus)}>
          {SUB_STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
        </select>
      </Field>
      <Field label="Renewal date (informational)"><input type="date" value={renews} onChange={(e) => setRenews(e.target.value)} /></Field>
      <div className="sh-actions"><button className="sh-btn sh-btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : sub ? 'Save subscription' : 'Create subscription'}</button></div>
    </section>
  );
}

export default function ShopDetailPage() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad((s) => getShop(id, s), [id]);
  const toast = useToast();
  const changed = (m: string) => { toast.show(m); reload(); };
  return (
    <>
      <Link className="sh-back" to="/admin/shops">← Shops</Link>
      {loading && !data && <Loading label="Loading shop" />}
      {error != null && <LoadError error={error} onRetry={reload} />}
      {data && (
        <>
          <h1 className="sh-wrap">{data.shop.displayName}</h1>
          <section className="sh-card" aria-labelledby="meta-h">
            <h2 id="meta-h">Details</h2>
            <dl className="sh-dl">
              <div><dt>Slug</dt><dd>/{data.shop.slug}</dd></div>
              <div><dt>Address</dt><dd>{data.shop.address || '—'}</dd></div>
              <div><dt>Accepting orders</dt><dd>{data.shop.acceptsOrders ? 'Yes' : 'No'}</dd></div>
              <div><dt>Created</dt><dd>{fmtDate(data.shop.createdAt)}</dd></div>
              {data.owners.map((o) => <div key={o.id}><dt>Owner</dt><dd className="sh-wrap">{o.displayName} · {o.email}</dd></div>)}
            </dl>
          </section>
          <section className="sh-card" aria-labelledby="use-h">
            <h2 id="use-h">Usage</h2>
            <dl className="sh-dl">
              <div><dt>Total orders</dt><dd>{data.usage.orderCount}</dd></div>
              <div><dt>Orders, last 30 days</dt><dd>{data.usage.ordersLast30Days}</dd></div>
              <div><dt>Pricing rules</dt><dd>{data.usage.pricingRuleCount}</dd></div>
              <div><dt>Last order</dt><dd>{fmtDate(data.usage.lastOrderAt)}</dd></div>
            </dl>
          </section>
          <section className="sh-card" aria-labelledby="os-h">
            <h2 id="os-h">Orders by status</h2>
            <dl className="sh-dl">{Object.entries(data.ordersByStatus).map(([k, v]) => <div key={k}><dt>{k.charAt(0) + k.slice(1).toLowerCase()}</dt><dd>{v}</dd></div>)}</dl>
          </section>
          <section className="sh-card" aria-labelledby="pr-h">
            <h2 id="pr-h">Pricing (read only)</h2>
            {data.pricingRules.length === 0 ? <p className="sh-muted">No pricing rules configured.</p> : (
              <dl className="sh-dl">
                {data.pricingRules.map((r) => (
                  <div key={r.id}>
                    <dt>{r.colourMode === 'colour' ? 'Colour' : 'B&W'} · {r.sides === 'duplex' ? 'Double-sided' : 'Single-sided'} · {r.paperSize}{r.active ? '' : ' (inactive)'}</dt>
                    <dd>{inr(r.pricePerSheetPaise)} / sheet</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section className="sh-card" aria-labelledby="ro-h">
            <h2 id="ro-h">Recent orders</h2>
            {data.recentOrders.length === 0 ? <p className="sh-muted">No orders yet.</p> : <AdminOrderRows items={data.recentOrders} showShop={false} />}
            <p className="sh-muted">Operational metadata only. Customer documents are not accessible to platform administrators.</p>
          </section>
          <StatusCard d={data} onChanged={changed} />
          <SubscriptionCard key={`${data.subscription?.updatedAt ?? 'none'}`} d={data} onChanged={changed} />
          <section className="sh-card" aria-labelledby="aud-h">
            <h2 id="aud-h">Recent audit entries</h2>
            <AuditList shopId={data.shop.id} pageSize={10} />
          </section>
        </>
      )}
      {toast.node}
    </>
  );
}
