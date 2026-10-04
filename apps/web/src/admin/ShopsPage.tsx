import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { createShop, inr, listPlans, listShops, slugHint, type AdminShop, type ShopStatus } from '../lib/admin-api';
import { Banner } from '../shop/components';
import { Field, LoadError, LoadMore, Loading, ShopStatusChip, adminError, useCursorList, useLoad } from './ui';

export function ShopsList() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<ShopStatus | ''>('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useCursorList<AdminShop>((cursor, signal) => listShops({ status, q: debounced, cursor, limit: 25 }, signal), [status, debounced]);
  return (
    <>
      <div className="sh-pagehead"><h1>Shops</h1><Link className="sh-btn sh-btn-primary sh-btn-sm" to="new">Create shop</Link></div>
      <div className="ad-filters" role="search">
        <Field label="Search name or slug"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label="Status">
          <select className="ad-select" value={status} onChange={(e) => setStatus(e.target.value as ShopStatus | '')}>
            <option value="">All</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option>
          </select>
        </Field>
      </div>
      {list.loading && <Loading label="Loading shops" />}
      {list.error != null && <LoadError error={list.error} onRetry={list.reload} />}
      {!list.loading && !list.error && list.items.length === 0 && <div className="sh-empty"><h2>No shops found</h2><p>{q || status ? 'Try different filters.' : 'Create the first shop.'}</p></div>}
      {!list.loading && list.items.length > 0 && (
        <>
          <ul className="ad-list" aria-label="Shops">
            {list.items.map((s) => (
              <li key={s.id} className="ad-row">
                <div><Link to={s.id}>{s.displayName}</Link><div className="sh-muted">/{s.slug}</div></div>
                <div style={{ textAlign: 'right' }}>
                  <ShopStatusChip status={s.status} />
                  <div className="sh-muted">{s.subscription ? `${s.subscription.plan.name} · ${s.subscription.status.toLowerCase()}` : 'No subscription'}</div>
                </div>
              </li>
            ))}
          </ul>
          <LoadMore hasMore={list.hasMore} more={list.more} onClick={list.loadMore} error={list.moreError} />
        </>
      )}
    </>
  );
}

function genPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function CreateShop() {
  const plans = useLoad((s) => listPlans(s), []);
  const [f, setF] = useState({ displayName: '', slug: '', ownerEmail: '', ownerName: '', password: '', planId: '' });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<{ slug?: string; email?: string; general?: string }>({});
  const [done, setDone] = useState<{ shopId: string; slug: string; email: string; password: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    if (k === 'slug') setServerErr((x) => ({ ...x, slug: '' }));
    if (k === 'ownerEmail') setServerErr((x) => ({ ...x, email: '' }));
  };

  const errs = {
    displayName: f.displayName.trim() ? null : 'Shop name is required.',
    slug: slugHint(f.slug),
    ownerEmail: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.ownerEmail.trim()) ? null : 'Enter a valid email.',
    ownerName: f.ownerName.trim() ? null : 'Owner name is required.',
    password: f.password.length >= 12 ? null : 'At least 12 characters.'
  };
  const invalid = Object.values(errs).some(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true);
    setServerErr({});
    try {
      const r = await createShop({
        slug: f.slug, displayName: f.displayName.trim(),
        ...(f.planId ? { planId: f.planId } : {}),
        owner: { email: f.ownerEmail.trim(), displayName: f.ownerName.trim(), password: f.password }
      });
      setDone({ shopId: r.shop.id, slug: r.shop.slug, email: r.owner.email, password: f.password });
      setF((x) => ({ ...x, password: '' }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const field = (err.details as { field?: string } | undefined)?.field;
        if (field === 'slug') setServerErr({ slug: 'This slug is already taken. Choose another.' });
        else if (field === 'owner.email') setServerErr({ email: 'An account with this email already exists.' });
        else setServerErr({ general: err.message });
      } else setServerErr({ general: adminError(err) });
    }
    setBusy(false);
  }

  if (done) {
    return (
      <>
        <h1>Shop created</h1>
        <Banner kind="ok">Shop /{done.slug} was created. Share these credentials with the owner securely.</Banner>
        <div className="sh-card">
          <p>Owner email: <b>{done.email}</b></p>
          <p>Initial password (shown once; it is not stored and cannot be retrieved later):</p>
          <div className="ad-secret" data-testid="initial-password">{done.password}</div>
          <div className="sh-actions"><Link className="sh-btn sh-btn-primary" to={`../${done.shopId}`}>Open shop</Link></div>
        </div>
      </>
    );
  }
  const show = (k: keyof typeof errs) => (touched ? errs[k] : null);
  const slugErr = serverErr.slug || show('slug');
  const emailErr = serverErr.email || show('ownerEmail');
  return (
    <>
      <Link className="sh-back" to="..">← Shops</Link>
      <h1>Create shop</h1>
      <form onSubmit={submit} noValidate aria-label="Create shop">
        {serverErr.general && <Banner kind="error">{serverErr.general}</Banner>}
        <Field label="Shop name" error={show('displayName')}><input value={f.displayName} onChange={set('displayName')} aria-invalid={!!show('displayName')} maxLength={100} /></Field>
        <Field label="Slug" hint="Used in the customer link (/p/your-slug). Lowercase letters, digits, hyphens." error={slugErr}>
          <input value={f.slug} onChange={set('slug')} autoCapitalize="none" spellCheck={false} aria-invalid={!!slugErr} maxLength={60} />
        </Field>
        <Field label="Owner name" error={show('ownerName')}><input value={f.ownerName} onChange={set('ownerName')} aria-invalid={!!show('ownerName')} maxLength={100} /></Field>
        <Field label="Owner email" error={emailErr}><input type="email" value={f.ownerEmail} onChange={set('ownerEmail')} aria-invalid={!!emailErr} autoComplete="off" /></Field>
        <Field label="Initial password" hint="Min 12 characters. Shown once after creation; the owner should change it." error={show('password')}>
          <input type="text" value={f.password} onChange={set('password')} aria-invalid={!!show('password')} autoComplete="off" spellCheck={false} />
        </Field>
        <button type="button" className="sh-btn sh-btn-sm" onClick={() => setF((x) => ({ ...x, password: genPassword() }))}>Generate password</button>
        <Field label="Plan (optional)">
          <select className="ad-select" value={f.planId} onChange={set('planId')}>
            <option value="">No plan yet</option>
            {(plans.data ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} — {inr(p.pricePaise)}/month</option>)}
          </select>
        </Field>
        <p className="sh-muted">Plan and payment are tracked manually; creating a shop never charges anyone.</p>
        <button className="sh-btn sh-btn-primary sh-btn-block" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create shop'}</button>
      </form>
    </>
  );
}
