import { useState, type FormEvent } from 'react';
import { inr, listPlans, paiseToRupees, rupeesToPaise, updatePlan, type Plan } from '../lib/admin-api';
import { Banner, useToast } from '../shop/components';
import { Field, LoadError, Loading, MANUAL_NOTE, adminError, useLoad } from './ui';

function PlanRow({ plan, onSaved }: { plan: Plan; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(plan.name);
  const [price, setPrice] = useState(paiseToRupees(plan.pricePaise));
  const [active, setActive] = useState(plan.active);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const paise = rupeesToPaise(price);
  const priceErr = paise === null ? 'Enter a rupee amount like 99 or 99.50.' : null;
  const nameErr = name.trim() ? null : 'Name is required.';
  const dirty = name.trim() !== plan.name || paise !== plan.pricePaise || active !== plan.active;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || priceErr || nameErr || paise === null) return;
    setBusy(true);
    setErr(null);
    try {
      await updatePlan(plan.id, { name: name.trim(), pricePaise: paise, active });
      onSaved(`Saved ${name.trim()}`);
    } catch (e2) { setErr(adminError(e2)); }
    setBusy(false);
  }
  return (
    <form className="sh-card" onSubmit={submit} noValidate aria-label={`Plan ${plan.name}`}>
      <h2>{plan.name} <span className="sh-muted">· currently {inr(plan.pricePaise)}/month</span></h2>
      {err && <Banner kind="error">{err}</Banner>}
      <Field label="Name" error={nameErr}><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-invalid={!!nameErr} /></Field>
      <Field label="Price per month (₹)" error={priceErr} hint="Stored as paise on the server.">
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!!priceErr} />
      </Field>
      <label className="sh-switch"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Available for new subscriptions</label>
      <div className="sh-actions"><button className="sh-btn sh-btn-primary" type="submit" disabled={busy || !dirty || !!priceErr || !!nameErr}>{busy ? 'Saving…' : 'Save plan'}</button></div>
    </form>
  );
}

export default function PlansPage() {
  const { data, error, loading, reload } = useLoad((s) => listPlans(s), []);
  const toast = useToast();
  return (
    <>
      <h1>Plans</h1>
      <Banner kind="info">{MANUAL_NOTE}</Banner>
      {loading && !data && <Loading label="Loading plans" />}
      {error != null && <LoadError error={error} onRetry={reload} />}
      {data && data.length === 0 && <div className="sh-empty"><p>No plans yet.</p></div>}
      {data?.map((p) => <PlanRow key={`${p.id}:${p.updatedAt ?? ''}`} plan={p} onSaved={(m) => { toast.show(m); reload(); }} />)}
      {toast.node}
    </>
  );
}
