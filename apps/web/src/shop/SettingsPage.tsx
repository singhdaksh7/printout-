import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { describeError, getQr, getSettings, putSettings, type ShopSettings } from '../lib/shop-api';
import { Banner, Button, Card, Checkbox, Chip, Icon, Skeleton, TextArea, TextField, useToast } from '../ui';
import { useUnsavedGuard } from './components';

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
  if (f.brandColor && !/^#[0-9a-fA-F]{6}$/.test(f.brandColor)) e.brandColor = 'Use a colour like #E8772E.';
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

  if (loadError) return <section className="pb-theme pb-page"><h1 className="pb-h1">Settings</h1><Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>{loadError}</Banner></section>;
  if (!saved) return <section className="pb-theme pb-page"><h1 className="pb-h1">Settings</h1><Skeleton lines={5} label="Loading settings" /></section>;

  const swatch = /^#[0-9a-fA-F]{6}$/.test(form.brandColor) ? form.brandColor : 'transparent';
  return (
    <section aria-labelledby="set-title" className="pb-theme pb-page pb-settings-page">
      <div className="pb-pagehead">
        <h1 id="set-title" className="pb-h1">Settings</h1>
        {dirty && <Chip tone="warn" role="status">Unsaved changes</Chip>}
      </div>
      {url && <p className="pb-muted pb-wrap">Your public shop page: <a href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>}
      {error && <Banner tone="err">{error}</Banner>}
      <Link className="pb-card pb-card--pad-md pb-linkcard" to="/shop/devices">
        <span><strong>Printing Devices</strong><br /><small className="pb-muted">Connect a phone or PC to print your orders.</small></span>
        <Icon name="chevron-right" size={20} />
      </Link>
      <Card>
      <form className="pb-settings-form" onSubmit={submit} noValidate>
        {present.has('displayName') && (
          <TextField label="Shop name" value={form.displayName} maxLength={100} error={errors.displayName} onChange={(e) => set('displayName', e.target.value)} />
        )}
        {present.has('address') && (
          <TextArea label="Address" rows={2} value={form.address} maxLength={300} error={errors.address} onChange={(e) => set('address', e.target.value)} />
        )}
        <TextField label="Public contact" helperText="Shown to customers, e.g. a counter phone or email." value={form.publicContact} maxLength={100} error={errors.publicContact} onChange={(e) => set('publicContact', e.target.value)} />
        <TextField
          label="Brand colour" helperText="Hex colour, e.g. #E8772E." placeholder="#E8772E" value={form.brandColor} maxLength={7} error={errors.brandColor}
          endAdornment={<span className="pb-swatch" style={{ background: swatch }} aria-hidden="true" />}
          onChange={(e) => set('brandColor', e.target.value)}
        />
        {present.has('acceptsOrders') && (
          <Checkbox label="Accepting new orders" checked={form.acceptsOrders} onChange={(e) => set('acceptsOrders', e.target.checked)} />
        )}
        <div className="pb-ratecard__actions">
          <Button variant="primary" type="submit" disabled={!dirty || saving} loading={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => { setForm(saved); setErrors({}); setError(null); }}>Reset</Button>
        </div>
      </form>
      </Card>
      {toast}
    </section>
  );
}
