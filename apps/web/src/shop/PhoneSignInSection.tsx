import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { describeError, getPhoneLoginConfig, getPhoneStatus, linkPhone, unlinkPhone, type PhoneLoginConfig, type PhoneStatus } from '../lib/shop-api';
import { Banner, Button, Card, CardHeader, Skeleton, TextField } from '../ui';
import { PhoneVerifier, type Classified } from './PhoneVerifier';
import './phone.css';

const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);

export function linkError(e: unknown): Classified {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'INVALID_CURRENT_PASSWORD': return { message: 'Your current password is incorrect. Check it and verify again.', restart: false };
      case 'PHONE_UNAVAILABLE': return { message: 'This number cannot be linked to your account. Try a different number.', restart: true };
      case 'PHONE_TOKEN_INVALID': return { message: 'We could not verify that code. Request a new one and try again.', restart: true };
      case 'PHONE_LOGIN_UNAVAILABLE': return { message: 'Phone sign-in is unavailable right now. Try again later.', restart: false };
      case 'RATE_LIMITED': return { message: 'Too many attempts. Please wait a minute and try again.', restart: false };
    }
    return { message: describeError(e), restart: false };
  }
  return { message: describeError(e), restart: false };
}

/** Settings > Phone sign-in: link, replace or unlink the mobile number used for SMS sign-in. Every change re-checks the password server-side. */
export default function PhoneSignInSection() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'link' | 'unlink'>('none');
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [absent, setAbsent] = useState(false);
  const [cfg, setCfg] = useState<PhoneLoginConfig | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    getPhoneLoginConfig().then(setCfg).catch(() => undefined);
    return getPhoneStatus().then(setStatus).catch((e) => { if (e instanceof ApiError && e.status === 404) setAbsent(true); else setLoadError(describeError(e)); });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const close = () => { setPanel('none'); setPassword(''); setConfirmed(false); setError(null); };
  const sessionsNote = (n: number) => (n > 0 ? ` You were signed out on ${n} other ${n === 1 ? 'device' : 'devices'}.` : '');

  async function onToken(idToken: string) {
    const r = await linkPhone(idToken, password);
    setNotice(`${r.replaced ? 'Number replaced' : 'Number linked'}: ${r.phoneMasked}.${sessionsNote(r.otherSessionsEnded)}`);
    close();
    await load();
  }

  async function doUnlink() {
    if (!password || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await unlinkPhone(password);
      setNotice(`Mobile number unlinked. You can still sign in with email and password.${sessionsNote(r?.otherSessionsEnded ?? 0)}`);
      close();
      await load();
    } catch (e) {
      setError(linkError(e).message);
    } finally { setBusy(false); }
  }

  if (absent) return null; // older API without phone sign-in
  if (loadError) return <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => void load()}>Retry</Button>}>{loadError}</Banner>;
  if (!status) return <Skeleton lines={2} label="Loading phone sign-in" />;
  if (!status.available && !status.linked) return null; // feature not enabled on this server

  return (
    <Card as="section" aria-labelledby="phone-signin-title" data-testid="phone-signin">
      <CardHeader id="phone-signin-title" title="Phone sign-in" />
      <div className="pb-phone-section">
        <p className="pb-muted">Sign in with a one-time SMS code instead of your password. Your email and password keep working either way.</p>
        {notice && <Banner tone="ok" onDismiss={() => setNotice(null)}>{notice}</Banner>}
        <div className="pb-phone-status" aria-live="polite">
          {status.linked ? (
            <span>
              Linked number: <span className="pb-phone-status__num" data-testid="phone-linked-number">{status.phoneMasked}</span>
              {fmt(status.linkedAt) && <small className="pb-muted"> · since {fmt(status.linkedAt)}</small>}
            </span>
          ) : <span>No mobile number linked.</span>}
          {panel === 'none' && (
            <span className="pb-phone-actions">
              <Button variant="outline" onClick={() => { setNotice(null); setPanel('link'); }} disabled={!status.available}>{status.linked ? 'Replace number' : 'Link mobile number'}</Button>
              {status.linked && <Button variant="ghost" onClick={() => { setNotice(null); setPanel('unlink'); }}>Unlink</Button>}
            </span>
          )}
        </div>

        {panel === 'link' && (
          <div className="pb-phone-section" data-testid="phone-link-panel">
            <p className="pb-phone-note">For your security, confirm your current password first, then verify the new number by SMS. Other devices will be signed out.</p>
            {error && <Banner tone="err">{error}</Banner>}
            <TextField label="Current password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {!confirmed ? (
              <div className="pb-phone-actions">
                <Button variant="primary" disabled={!password} onClick={() => setConfirmed(true)}>Continue</Button>
                <Button variant="ghost" onClick={close}>Cancel</Button>
              </div>
            ) : (
              <>
                <PhoneVerifier
                  allowedCallingCodes={cfg?.allowedCallingCodes ?? ['+91']}
                  defaultCallingCode={cfg?.defaultCallingCode ?? '+91'}
                  resendCooldownSeconds={cfg?.resendCooldownSeconds ?? 30}
                  onToken={onToken}
                  classify={linkError}
                  verifyLabel={status.linked ? 'Verify and replace' : 'Verify and link'}
                  idPrefix="link"
                />
                <Button variant="ghost" onClick={close}>Cancel</Button>
              </>
            )}
          </div>
        )}

        {panel === 'unlink' && (
          <form className="pb-phone-section" data-testid="phone-unlink-panel" onSubmit={(e) => { e.preventDefault(); void doUnlink(); }}>
            <p className="pb-phone-note">You will no longer be able to sign in by SMS. Email and password still work. Other devices will be signed out.</p>
            {error && <Banner tone="err">{error}</Banner>}
            <TextField label="Current password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            <div className="pb-phone-actions">
              <Button type="submit" variant="danger" disabled={!password || busy} loading={busy}>{busy ? 'Unlinking…' : 'Unlink number'}</Button>
              <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
