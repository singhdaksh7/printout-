import { forwardRef, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { changeAdminEmail, changeAdminPassword, fmtDate, getAccount, type AdminAccount } from '../lib/admin-api';
import { useAuth } from '../shop/auth';
import { Banner, Button, Card, CardHeader, KeyValueList, TextField, type TextFieldProps } from '../ui';
import { LoadError, Loading, useLoad } from './ui';

const MIN_PASSWORD = 12;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** Maps an API failure to a field message (focus goes to that field) or a form-level message. */
function mapError(e: unknown, fields: { current: string; email?: string; password?: string }): { field?: 'current' | 'email' | 'password'; message: string } {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CURRENT_PASSWORD') return { field: 'current', message: fields.current };
    if (e.code === 'EMAIL_UNAVAILABLE' && fields.email) return { field: 'email', message: fields.email };
    if (e.code === 'VALIDATION_ERROR' && fields.password) return { field: 'password', message: e.message === 'Request validation failed' ? 'Choose a different password.' : e.message };
    if (e.code === 'VALIDATION_ERROR' && fields.email) return { field: 'email', message: e.message === 'Request validation failed' ? 'Enter a valid email address.' : e.message };
    if (e.status === 429 || e.code === 'RATE_LIMITED') return { message: 'Too many attempts. Wait a few minutes before trying again.' };
    if (e.code === 'NETWORK_ERROR') return { message: e.message };
    if (e.code === 'CONFLICT') return { message: 'Your account changed while you were saving. Reload the page and try again.' };
    if (e.status >= 500) return { message: 'The server had a problem. Nothing was changed. Please try again shortly.' };
  }
  return { message: 'Could not save your changes. Please try again.' };
}

/** TextField with a Show/Hide control. The toggle is a real button (keyboard + screen reader friendly), not an icon-only target. */
const PasswordField = forwardRef<HTMLInputElement, Omit<TextFieldProps, 'type' | 'endAdornment'>>(function PasswordField({ label, disabled, ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      ref={ref}
      label={label}
      type={shown ? 'text' : 'password'}
      disabled={disabled}
      autoCapitalize="none"
      spellCheck={false}
      endAdornment={
        <Button variant="ghost" size="sm" aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`} onClick={() => setShown((v) => !v)} disabled={disabled}>
          {shown ? 'Hide' : 'Show'}
        </Button>
      }
      {...rest}
    />
  );
});

/**
 * Focus that waits for the form to be re-enabled: a field is `disabled` while saving, and a disabled input cannot take
 * focus, so server-side field errors request focus here and it is applied once `busy` has dropped.
 */
function useFocusAfterBusy(busy: boolean) {
  const target = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!busy && target.current) { target.current.focus(); target.current = null; }
  }, [busy]);
  return (el: HTMLInputElement | null) => { target.current = el; };
}

/** Form-level error region: focused when a non-field error appears so keyboard and screen-reader users land on it. */
function FormError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (message) ref.current?.focus(); }, [message]);
  return <div ref={ref} tabIndex={-1} className="ad-formerr">{message && <Banner tone="err">{message}</Banner>}</div>;
}

function EmailForm({ account, onChanged }: { account: AdminAccount; onChanged: () => void }) {
  const [newEmail, setNewEmail] = useState('');
  const [current, setCurrent] = useState('');
  const [errors, setErrors] = useState<FieldErrors<'email' | 'current'>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const focusWhenIdle = useFocusAfterBusy(busy);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: FieldErrors<'email' | 'current'> = {};
    const trimmed = newEmail.trim();
    if (!trimmed) next.email = 'Enter the new email address.';
    else if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) next.email = 'Enter a valid email address.';
    else if (trimmed.toLowerCase() === account.email.toLowerCase()) next.email = 'This is already your email address.';
    if (!current) next.current = 'Enter your current password to confirm.';
    setErrors(next);
    setFormError(null);
    if (next.email) return void emailRef.current?.focus();
    if (next.current) return void currentRef.current?.focus();
    setBusy(true);
    try {
      await changeAdminEmail({ currentPassword: current, newEmail: trimmed });
      onChanged();
    } catch (err) {
      const m = mapError(err, { current: 'Current password is incorrect.', email: 'This email address cannot be used. Choose a different one.' });
      if (m.field === 'current') { setErrors({ current: m.message }); focusWhenIdle(currentRef.current); setCurrent(''); }
      else if (m.field === 'email') { setErrors({ email: m.message }); focusWhenIdle(emailRef.current); }
      else setFormError(m.message);
      setBusy(false);
    }
  }

  return (
    <Card as="section" aria-labelledby="ad-email-title">
      <form onSubmit={submit} noValidate className="ad-form" aria-labelledby="ad-email-title">
        <CardHeader id="ad-email-title" title="Change email" />
        <p className="pb-muted">You will use the new address to sign in. For safety you are signed out on all devices after the change.</p>
        <FormError message={formError} />
        <TextField ref={emailRef} label="New email" type="email" autoComplete="off" value={newEmail} onChange={(e) => { setNewEmail(e.target.value); setErrors((x) => ({ ...x, email: undefined })); }} error={errors.email} disabled={busy} required />
        <PasswordField ref={currentRef} label="Current password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setErrors((x) => ({ ...x, current: undefined })); }} error={errors.current} disabled={busy} required />
        <div className="ad-actions"><Button type="submit" variant="primary" loading={busy}>{busy ? 'Changing email…' : 'Change email'}</Button></div>
      </form>
    </Card>
  );
}

function PasswordForm({ account, onChanged }: { account: AdminAccount; onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors<'current' | 'password' | 'confirm'>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const focusWhenIdle = useFocusAfterBusy(busy);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found: FieldErrors<'current' | 'password' | 'confirm'> = {};
    if (!current) found.current = 'Enter your current password.';
    if (next.length < MIN_PASSWORD) found.password = `Use at least ${MIN_PASSWORD} characters.`;
    else if (next === current) found.password = 'The new password must be different from the current one.';
    else if (account.email.split('@')[0]!.length >= 4 && next.toLowerCase().includes(account.email.split('@')[0]!.toLowerCase())) found.password = 'The password must not contain your email name.';
    if (!found.password && next !== confirm) found.confirm = 'The passwords do not match.';
    setErrors(found);
    setFormError(null);
    if (found.current) return void currentRef.current?.focus();
    if (found.password) return void nextRef.current?.focus();
    if (found.confirm) return void confirmRef.current?.focus();
    setBusy(true);
    try {
      await changeAdminPassword({ currentPassword: current, newPassword: next });
      onChanged();
    } catch (err) {
      const m = mapError(err, { current: 'Current password is incorrect.', password: 'Choose a different password.' });
      if (m.field === 'current') { setErrors({ current: m.message }); focusWhenIdle(currentRef.current); setCurrent(''); }
      else if (m.field === 'password') { setErrors({ password: m.message }); focusWhenIdle(nextRef.current); }
      else setFormError(m.message);
      setBusy(false);
    }
  }

  return (
    <Card as="section" aria-labelledby="ad-password-title">
      <form onSubmit={submit} noValidate className="ad-form" aria-labelledby="ad-password-title">
        <CardHeader id="ad-password-title" title="Change password" />
        <p className="pb-muted">You are signed out on all devices after the change and sign in again with the new password.</p>
        <FormError message={formError} />
        <PasswordField ref={currentRef} label="Current password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setErrors((x) => ({ ...x, current: undefined })); }} error={errors.current} disabled={busy} required />
        <PasswordField ref={nextRef} label="New password" autoComplete="new-password" helperText={`At least ${MIN_PASSWORD} characters. Avoid common words and your email name.`} value={next} onChange={(e) => { setNext(e.target.value); setErrors((x) => ({ ...x, password: undefined, confirm: undefined })); }} error={errors.password} disabled={busy} required />
        <PasswordField ref={confirmRef} label="Confirm new password" autoComplete="new-password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setErrors((x) => ({ ...x, confirm: undefined })); }} error={errors.confirm} disabled={busy} required />
        <div className="ad-actions"><Button type="submit" variant="primary" loading={busy}>{busy ? 'Changing password…' : 'Change password'}</Button></div>
      </form>
    </Card>
  );
}

export default function AccountPage() {
  const { logout, endSession } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad((s) => getAccount(s), []);
  const [leaving, setLeaving] = useState(false);

  /** The server already ended every session of this admin: leave the screen first, then drop the local session. */
  function credentialsChanged(kind: 'email' | 'password') {
    navigate('/admin/login', { replace: true, state: { credentialsChanged: kind } });
    endSession();
  }
  async function signOut() {
    setLeaving(true);
    await logout();
    navigate('/admin/login', { replace: true });
  }

  return (
    <div className="ad-account">
      <div>
        <h1 className="pb-h1">Account settings</h1>
        <p className="pb-muted pb-pagehead__sub">Your platform admin sign-in details. Only you can change them, and only with your current password.</p>
      </div>
      {loading && !data && <Loading label="Loading account" />}
      {error != null && !data && <LoadError error={error} onRetry={reload} />}
      {data && (
        <>
          <Card as="section" aria-labelledby="ad-details-title">
            <CardHeader id="ad-details-title" title="Account details" />
            <KeyValueList items={[
              { label: 'Name', value: data.displayName },
              { label: 'Email', value: data.email },
              { label: 'Role', value: 'Platform admin' },
              { label: 'Account created', value: fmtDate(data.createdAt) }
            ]} />
          </Card>
          <Card as="section" aria-labelledby="ad-session-title">
            <CardHeader id="ad-session-title" title="Current session" />
            <KeyValueList items={[
              { label: 'Signed in since', value: fmtDate(data.session.startedAt) },
              { label: 'Session expires', value: fmtDate(data.session.expiresAt) },
              { label: 'Other active sessions', value: String(data.session.otherActiveSessions) }
            ]} />
            <div className="ad-actions">
              <Button variant="outline" iconStart="log-out" onClick={signOut} loading={leaving}>Sign out</Button>
            </div>
          </Card>
          <EmailForm account={data} onChanged={() => credentialsChanged('email')} />
          <PasswordForm account={data} onChanged={() => credentialsChanged('password')} />
        </>
      )}
    </div>
  );
}
