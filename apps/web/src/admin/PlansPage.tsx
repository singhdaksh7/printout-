import { useState, type FormEvent } from 'react';
import { inr, listPlans, paiseToRupees, rupeesToPaise, updatePlan, type Plan } from '../lib/admin-api';
import { Banner, Button, Card, CardHeader, Checkbox, EmptyState, TextField, useToast } from '../ui';
import { LoadError, Loading, MANUAL_NOTE, adminError, useLoad } from './ui';

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
    <Card>
      <form onSubmit={submit} noValidate aria-label={`Plan ${plan.name}`} className="ad-form">
        <CardHeader title={<>{plan.name} <span className="pb-muted">· currently {inr(plan.pricePaise)}/month</span></>} />
        {err && <Banner tone="err">{err}</Banner>}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} error={nameErr} />
        <TextField label="Price per month (₹)" helperText="Stored as paise on the server." inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={priceErr} />
        <Checkbox label="Available for new subscriptions" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <div className="ad-actions"><Button variant="primary" type="submit" disabled={busy || !dirty || !!priceErr || !!nameErr} loading={busy}>{busy ? 'Saving…' : 'Save plan'}</Button></div>
      </form>
    </Card>
  );
}

export default function PlansPage() {
  const { data, error, loading, reload } = useLoad((s) => listPlans(s), []);
  const toast = useToast();
  return (
    <>
      <h1 className="pb-h1">Plans</h1>
      <Banner tone="info">{MANUAL_NOTE}</Banner>
      {loading && !data && <Loading label="Loading plans" />}
      {error != null && <LoadError error={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState icon="receipt" title="No plans yet" />}
      {data?.map((p) => <PlanRow key={`${p.id}:${p.updatedAt ?? ''}`} plan={p} onSaved={(m) => { toast.show(m); reload(); }} />)}
      {toast.node}
    </>
  );
}
