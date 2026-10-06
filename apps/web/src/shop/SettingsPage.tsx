import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { describeError, getQr, getSettings, putSettings, type ShopSettings } from '../lib/shop-api';
import { Banner, Skeleton, useToast, useUnsavedGuard } from './components';

interface Form { displayName: string; address: string; publicContact: string; brandColor: string; acceptsOrders: boolean }
const toForm = (s: ShopSettings | null): Form => ({
  displayName: s?.displayName ?? '', address: s?.address ?? '', publicContact: s?.publicContact ?? '',
  brandColor: s?.brandColor ?? '', acceptsOrders: s?.acceptsOrders ?? true
});

function validate(f: Form, has: Set<string>): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  if (has.has('displayName') && (f.displayName.trim().length < 1 || f.displayName.length > 100)) e.displayName = 'Enter a shop name (up to 100 characters).';
  if (f.address.length > 300) e.address = 'Address is too long (max 300 characters).';
  if (f.publicContact.length > 100) e.publicContact = 'Contact is too long (max 100 characters).';
  if (f.brandColor && !/^#[0-9a-fA-F]{6}$/.test(f.brandColor)) e.brandColor = 'Use a colour like #1D4ED8.';
  return e;
}

export default function SettingsPage() {
  const [saved, setSaved] = useState<Form | null>(null);
  const [form, setForm] = useState<Form>(toForm(null));
  const [present, setPresent] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const { show, node: toast } = useToast();

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    getSettings().then((s) => {
      if (!alive) return;
      const f = toForm(s);
      setSaved(f); setForm(f);
      setPresent(new Set(Object.keys(s ?? {})));
    }).catch((e) => { if (alive) setLoadError(describeError(e)); });
    getQr().then((q) => { if (alive) setUrl(q.publicUrl); }).catch(() => { /* optional */ });
    return () => { alive = false; };
  }, [attempt]);

  const dirty = !!saved && (Object.keys(form) as (keyof Form)[]).some((k) => form[k] !== saved[k]);
  useUnsavedGuard(dirty, 'settings');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); setError(null); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || !dirty) return;
    const errs = validate(form, present);
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    setSaving(true); setError(null);
    // Explicit allow-list only.
    const body: ShopSettings = {
      publicContact: form.publicContact.trim() || null,
      brandColor: form.brandColor.trim() || null
    };
    if (present.has('displayName')) body.displayName = form.displayName.trim();
    if (present.has('address')) body.address = form.address.trim() || null;
    if (present.has('acceptsOrders')) body.acceptsOrders = form.acceptsOrders;
    try {
      const res = await putSettings(body);
      const f = toForm({ ...body, ...(res ?? {}) });
      setSaved(f); setForm(f);
      show('Settings saved');
    } catch (err) {
      setError(describeError(err));
    } finally { setSaving(false); }
  }

  if (loadError) return <section><h1>Settings</h1><Banner onRetry={() => setAttempt((n) => n + 1)}>{loadError}</Banner></section>;
  if (!saved) return <section><h1>Settings</h1><Skeleton lines={5} label="Loading settings" /></section>;

  return (
    <section aria-labelledby="set-title">
      <div className="sh-pagehead">
        <h1 id="set-title">Settings</h1>
        {dirty && <span className="sh-chip sh-chip-warn" role="status">Unsaved changes</span>}
      </div>
      {url && <p className="sh-muted sh-wrap">Your public shop page: <a href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>}
      {error && <Banner>{error}</Banner>}
      <Link className="sh-card dev-link-card" to="/shop/devices">
        <span><strong>Printing Devices</strong><br /><small className="sh-muted">Connect a phone or PC to print your orders.</small></span>
        <span aria-hidden="true">›</span>
      </Link>
      <form className="sh-card sh-form" onSubmit={submit} noValidate>
        {present.has('displayName') && (
          <Field label="Shop name" error={errors.displayName}>
            <input value={form.displayName} maxLength={100} onChange={(e) => set('displayName', e.target.value)} aria-invalid={!!errors.displayName} />
          </Field>
        )}
        {present.has('address') && (
          <Field label="Address" error={errors.address}>
            <textarea rows={2} value={form.address} maxLength={300} onChange={(e) => set('address', e.target.value)} aria-invalid={!!errors.address} />
          </Field>
        )}
        <Field label="Public contact" hint="Shown to customers, e.g. a counter phone or email." error={errors.publicContact}>
          <input value={form.publicContact} maxLength={100} onChange={(e) => set('publicContact', e.target.value)} aria-invalid={!!errors.publicContact} />
        </Field>
        <Field label="Brand colour" hint="Hex colour, e.g. #1D4ED8." error={errors.brandColor}>
          <div className="sh-colour-row">
            <input value={form.brandColor} placeholder="#1D4ED8" maxLength={7} onChange={(e) => set('brandColor', e.target.value)} aria-invalid={!!errors.brandColor} />
            <span className="sh-swatch" style={{ background: /^#[0-9a-fA-F]{6}$/.test(form.brandColor) ? form.brandColor : 'transparent' }} aria-hidden="true" />
          </div>
        </Field>
        {present.has('acceptsOrders') && (
          <label className="sh-switch">
            <input type="checkbox" checked={form.acceptsOrders} onChange={(e) => set('acceptsOrders', e.target.checked)} />
            <span>Accepting new orders</span>
          </label>
        )}
        <div className="sh-actions">
          <button className="sh-btn sh-btn-primary" type="submit" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save settings'}</button>
          <button className="sh-btn" type="button" disabled={!dirty || saving} onClick={() => { setForm(saved); setErrors({}); setError(null); }}>Reset</button>
        </div>
      </form>
      {toast}
    </section>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: React.ReactNode }) {
  return (
    <label className="sh-field">
      <span>{label}</span>
      {children}
      {hint && <small className="sh-muted">{hint}</small>}
      {error && <small className="sh-field-error" role="alert">{error}</small>}
    </label>
  );
}
