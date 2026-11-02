import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import {
  describeError, getSetupStatus, getShopProfile, normalisePhone, patchShopProfile, putPaperOptions, UPI_ID_REGEX,
  type SetupStatus
} from '../lib/shop-api';
import { Banner, Button, Card, Checkbox, Chip, Skeleton, TextField, buttonClass } from '../ui';
import PricingPage from './PricingPage';
import { PINCODE_REGEX } from './RegisterShopPage';
import { SETUP_STEPS, STEP_OF_SECTION, StepIndicator, type SetupStepKey } from './SetupSteps';

/** Server validation messages are specific and safe to show; everything else uses the shared wording. */
function saveError(e: unknown): string {
  if (e instanceof ApiError && (e.code === 'VALIDATION_ERROR' || e.code === 'UNSUPPORTED_PAPER' || e.code === 'RATE_NOT_SET') && e.message) return e.message;
  return describeError(e);
}

const nextOf = (k: SetupStepKey): SetupStepKey => SETUP_STEPS[Math.min(SETUP_STEPS.findIndex((s) => s.key === k) + 1, SETUP_STEPS.length - 1)]!.key;
export const firstIncompleteStep = (s: SetupStatus): SetupStepKey => (s.nextStep ? STEP_OF_SECTION[s.nextStep] : 'finish');

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<SetupStepKey | null>(null);
  const first = useRef(true);

  const load = useCallback(async (): Promise<SetupStatus | null> => {
    setLoadError(null);
    try {
      const s = await getSetupStatus();
      setStatus(s);
      // Resume at the first incomplete step on the first load only; afterwards the owner moves with Continue.
      if (first.current) { first.current = false; setStep(firstIncompleteStep(s)); }
      return s;
    } catch (e) {
      setLoadError(describeError(e));
      return null;
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const advance = useCallback(async () => {
    await load();
    setStep((cur) => (cur ? nextOf(cur) : cur));
  }, [load]);

  if (!status || !step) {
    return (
      <section aria-labelledby="setup-title" className="pb-theme pb-page">
        <h1 id="setup-title" className="pb-h1">Set up your shop</h1>
        {loadError
          ? <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => void load()}>Retry</Button>}>{loadError}</Banner>
          : <Skeleton lines={4} label="Loading setup" />}
      </section>
    );
  }

  return (
    <div data-testid="setup-page">
      <div className="pb-theme pb-page" style={{ paddingBottom: 0 }}>
        <StepIndicator current={step} />
      </div>
      {step === 'details' && <DetailsStep status={status} onDone={advance} />}
      {step === 'rates' && <PricingPage onboarding onContinue={() => void advance()} />}
      {step === 'paper' && <PaperStep status={status} onDone={advance} onBack={() => setStep('rates')} />}
      {step === 'payments' && <PaymentsStep status={status} onDone={advance} />}
      {step === 'finish' && <FinishStep status={status} onGo={setStep} />}
    </div>
  );
}

function DetailsStep({ status, onDone }: { status: SetupStatus; onDone: () => Promise<void> }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [vals, setVals] = useState({ phone: '', address: '', city: '', state: '', pincode: '' });
  const [errs, setErrs] = useState<Partial<Record<keyof typeof vals, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const p = await getShopProfile(status.shopId);
      setVals({ phone: p.phoneNumber ?? '', address: p.addressLine1 ?? '', city: p.city ?? '', state: p.state ?? '', pincode: p.pincode ?? '' });
    } catch (e) { setLoadError(describeError(e)); } finally { setLoading(false); }
  }, [status.shopId]);
  useEffect(() => { void load(); }, [load]);

  const set = (k: keyof typeof vals, v: string) => { setVals((x) => ({ ...x, [k]: v })); setErrs((x) => ({ ...x, [k]: undefined })); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const next: typeof errs = {};
    const phone = normalisePhone(vals.phone);
    if (!phone) next.phone = 'Enter a 10-digit mobile number or a number starting with +.';
    if (vals.address.trim().length < 5) next.address = 'Enter the shop address (at least 5 characters).';
    if (!vals.city.trim()) next.city = 'City is required.';
    if (!vals.state.trim()) next.state = 'State is required.';
    if (!PINCODE_REGEX.test(vals.pincode.trim())) next.pincode = 'Enter a valid 6-digit PIN code.';
    setErrs(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await patchShopProfile(status.shopId, { phoneNumber: phone!, addressLine1: vals.address.trim(), city: vals.city.trim(), state: vals.state.trim(), pincode: vals.pincode.trim() });
      await onDone();
    } catch (err) { setError(saveError(err)); } finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="details-title" className="pb-theme pb-page">
      <h1 id="details-title" className="pb-h1">Shop details</h1>
      <p className="pb-muted">Owner name and Google email were saved when you registered.</p>
      {loadError && <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => void load()}>Retry</Button>}>{loadError}</Banner>}
      {error && <Banner tone="err">{error}</Banner>}
      {loading ? <Skeleton lines={4} label="Loading details" /> : !loadError && (
        <form onSubmit={(e) => void submit(e)} noValidate className="pb-login__form" style={{ maxWidth: 480 }}>
          <TextField label="Shop Phone" required value={vals.phone} error={errs.phone} disabled={busy} inputMode="tel" autoComplete="tel" onChange={(e) => set('phone', e.target.value)} />
          <TextField label="Shop Address" required value={vals.address} error={errs.address} disabled={busy} maxLength={300} onChange={(e) => set('address', e.target.value)} />
          <TextField label="City" required value={vals.city} error={errs.city} disabled={busy} maxLength={100} onChange={(e) => set('city', e.target.value)} />
          <TextField label="State" required value={vals.state} error={errs.state} disabled={busy} maxLength={100} onChange={(e) => set('state', e.target.value)} />
          <TextField label="PIN Code" required value={vals.pincode} error={errs.pincode} disabled={busy} maxLength={6} inputMode="numeric" onChange={(e) => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} />
          <div><Button type="submit" variant="primary" loading={busy} disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</Button></div>
        </form>
      )}
      <LaterLink />
    </section>
  );
}

function PaperStep({ status, onDone, onBack }: { status: SetupStatus; onDone: () => Promise<void>; onBack: () => void }) {
  const hasRate = status.sections.rates.complete;
  const [a4, setA4] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await putPaperOptions(status.shopId, ['A4'], ['normal']);
      await onDone();
    } catch (e) { setError(saveError(e)); } finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="paper-title" className="pb-theme pb-page">
      <h1 id="paper-title" className="pb-h1">Paper</h1>
      <p className="pb-muted">Customers can only choose paper you have a price for.</p>
      {!status.sections.paper.complete && <div><Chip size="sm" dot={false}>Not configured</Chip></div>}
      {!hasRate && (
        <Banner tone="warn" actions={<Button size="sm" variant="dark" onClick={onBack}>Set printing rates</Button>}>
          Set at least one active price before choosing paper.
        </Banner>
      )}
      {error && <Banner tone="err">{error}</Banner>}
      <Card>
        <Checkbox label="A4" checked={a4} disabled={!hasRate || busy} onChange={(e) => setA4(e.target.checked)} />
        <Checkbox label="Plain paper" hint="Other paper types are not supported yet." checked disabled readOnly />
      </Card>
      <div><Button variant="primary" onClick={() => void save()} loading={busy} disabled={!hasRate || !a4 || busy}>{busy ? 'Saving…' : 'Save and continue'}</Button></div>
      <LaterLink />
    </section>
  );
}

function PaymentsStep({ status, onDone }: { status: SetupStatus; onDone: () => Promise<void> }) {
  const saved = status.sections.payments;
  const [cash, setCash] = useState(saved.methods.includes('cash'));
  const [upi, setUpi] = useState(saved.methods.includes('upi'));
  const [upiId, setUpiId] = useState(saved.upiId ?? '');
  const [upiError, setUpiError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setError(null); setUpiError(undefined);
    if (!cash && !upi) { setError('Choose at least one payment method.'); return; }
    if (upi && !UPI_ID_REGEX.test(upiId.trim())) { setUpiError(upiId.trim() ? 'Enter a valid UPI ID such as name@bank.' : 'A UPI ID is required to accept UPI.'); return; }
    setBusy(true);
    try {
      await patchShopProfile(status.shopId, {
        acceptedPaymentMethods: [...(cash ? ['cash' as const] : []), ...(upi ? ['upi' as const] : [])],
        ...(upi ? { upiId: upiId.trim() } : {})
      });
      await onDone();
    } catch (e) { setError(saveError(e)); } finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="payments-title" className="pb-theme pb-page">
      <h1 id="payments-title" className="pb-h1">Payments</h1>
      {!saved.complete && <div><Chip size="sm" dot={false}>Not configured</Chip></div>}
      {error && <Banner tone="err">{error}</Banner>}
      <Card>
        <Checkbox label="Cash" checked={cash} disabled={busy} onChange={(e) => setCash(e.target.checked)} />
        <Checkbox label="UPI" checked={upi} disabled={busy} onChange={(e) => { setUpi(e.target.checked); setUpiError(undefined); }} />
        {upi && (
          <TextField label="UPI ID" required value={upiId} error={upiError ?? null} disabled={busy} placeholder="name@bank" autoComplete="off" onChange={(e) => { setUpiId(e.target.value); setUpiError(undefined); }} />
        )}
      </Card>
      <div><Button variant="primary" onClick={() => void save()} loading={busy} disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</Button></div>
      <LaterLink />
    </section>
  );
}

function FinishStep({ status, onGo }: { status: SetupStatus; onGo: (k: SetupStepKey) => void }) {
  const { profile, rates, paper, payments } = status.sections;
  const rows: { key: SetupStepKey; label: string; ok: boolean; detail: string }[] = [
    { key: 'details', label: 'Shop details', ok: profile.complete, detail: profile.complete ? 'Saved' : 'Not configured' },
    { key: 'rates', label: 'Printing rates', ok: rates.complete, detail: rates.complete ? `${rates.activeCount} active` : 'Not configured' },
    { key: 'paper', label: 'Paper', ok: paper.complete, detail: paper.complete ? 'Saved' : 'Not configured' },
    { key: 'payments', label: 'Payments', ok: payments.complete, detail: payments.complete ? payments.methods.map((m) => (m === 'cash' ? 'Cash' : 'UPI')).join(', ') : 'Not configured' }
  ];
  return (
    <section aria-labelledby="finish-title" className="pb-theme pb-page">
      <h1 id="finish-title" className="pb-h1">{status.complete ? 'Setup complete' : 'Setup not finished'}</h1>
      <Card>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.75rem' }}>
          {rows.map((r) => (
            <li key={r.key} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{r.label}</span>
              <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <Chip size="sm" dot={false} tone={r.ok ? 'ok' : 'neutral'}>{r.detail}</Chip>
                {!r.ok && <Button size="sm" variant="outline" onClick={() => onGo(r.key)}>Fix</Button>}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <div><Link className={buttonClass({ variant: 'primary' })} to="/shop" data-testid="setup-finish">Go to dashboard</Link></div>
    </section>
  );
}

function LaterLink() {
  return <p><Link to="/shop" className="pb-muted">Finish later</Link></p>;
}
