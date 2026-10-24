import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { PhoneAuthError, googleAuthErrorMessage, signInWithGoogleWeb } from '../lib/phone-auth';
import { describeError, getUserIdentities, linkGoogleIdentity, unlinkGoogleIdentity, type UserIdentities } from '../lib/shop-api';
import { Banner, Button, Card, CardHeader, Skeleton, TextField } from '../ui';
import './phone.css';

export function googleLinkError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'INVALID_CURRENT_PASSWORD': return 'Your current password is incorrect. Check it and try again.';
      case 'GOOGLE_IDENTITY_UNAVAILABLE': return 'This Google account is already linked to another shop account. Try a different Google account.';
      case 'GOOGLE_TOKEN_INVALID': return 'We could not verify that Google account. Try again.';
      case 'LAST_SIGNIN_METHOD': return 'This is your only way to sign in, so it cannot be removed.';
      case 'RATE_LIMITED': return 'Too many attempts. Please wait a minute and try again.';
      case 'GOOGLE_LOGIN_UNAVAILABLE': return 'Google sign-in is unavailable right now. Try again later.';
    }
    return describeError(e);
  }
  if (e instanceof PhoneAuthError) {
    return googleAuthErrorMessage(e);
  }
  return describeError(e);
}

/** Settings > Google sign-in: link, replace or unlink the Google account used for shop sign-in. */
export default function GoogleAccountSection() {
  const [identities, setIdentities] = useState<UserIdentities | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'link' | 'unlink'>('none');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [absent, setAbsent] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    return getUserIdentities()
      .then(setIdentities)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setAbsent(true);
        else setLoadError(describeError(e));
      });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const close = () => { setPanel('none'); setPassword(''); setError(null); };
  const sessionsNote = (n: number) => (n > 0 ? ` You were signed out on ${n} other ${n === 1 ? 'device' : 'devices'}.` : '');

  async function doLink() {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await signInWithGoogleWeb();
      const r = await linkGoogleIdentity(idToken, password);
      setNotice(`${r.replaced ? 'Google account replaced' : 'Google account linked'}: ${r.emailMasked}.${sessionsNote(r.otherSessionsEnded)}`);
      close();
      await load();
    } catch (e) {
      setError(googleLinkError(e));
    } finally {
      setBusy(false);
    }
  }

  async function doUnlink(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await unlinkGoogleIdentity(password);
      setNotice(`Google account unlinked. You can still sign in with email and password.${sessionsNote(r?.otherSessionsEnded ?? 0)}`);
      close();
      await load();
    } catch (e) {
      setError(googleLinkError(e));
    } finally {
      setBusy(false);
    }
  }

  if (absent) return null; // older API without identities endpoint
  if (loadError) return <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => void load()}>Retry</Button>}>{loadError}</Banner>;
  if (!identities) return <Skeleton lines={2} label="Loading Google sign-in" />;
  if (!identities.googleAvailable && !identities.google.linked) return null; // feature not enabled on this server

  return (
    <Card as="section" aria-labelledby="google-account-title" data-testid="google-account-section">
      <CardHeader id="google-account-title" title="Google sign-in" />
      <div className="pb-phone-section">
        <p className="pb-muted">Link your Google account to sign in with one click. Your email and password keep working either way.</p>
        {notice && <Banner tone="ok" onDismiss={() => setNotice(null)}>{notice}</Banner>}
        <div className="pb-phone-status" aria-live="polite">
          {identities.google.linked ? (
            <span>
              Linked Google account: <span className="pb-phone-status__num" data-testid="google-linked-email">{identities.google.emailMasked}</span>
            </span>
          ) : <span>No Google account linked.</span>}
          {panel === 'none' && (
            <span className="pb-phone-actions">
              <Button
                variant="outline"
                onClick={() => { setNotice(null); setPanel('link'); }}
                disabled={!identities.googleAvailable}
              >
                {identities.google.linked ? 'Replace Google account' : 'Link Google account'}
              </Button>
              {identities.google.linked && (
                <Button variant="ghost" onClick={() => { setNotice(null); setPanel('unlink'); }}>
                  Unlink
                </Button>
              )}
            </span>
          )}
        </div>

        {panel === 'link' && (
          <div className="pb-phone-section" data-testid="google-link-panel">
            <p className="pb-phone-note">For your security, confirm your current password first, then sign in with Google in the popup. Other devices will be signed out.</p>
            {error && <Banner tone="err">{error}</Banner>}
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <div className="pb-phone-actions">
              <Button
                variant="primary"
                disabled={!password || busy}
                loading={busy}
                onClick={doLink}
                data-testid="google-link-btn"
              >
                {busy ? 'Signing in with Google…' : 'Continue with Google'}
              </Button>
              <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            </div>
          </div>
        )}

        {panel === 'unlink' && (
          <form className="pb-phone-section" data-testid="google-unlink-panel" onSubmit={doUnlink}>
            <p className="pb-phone-note">You will no longer be able to sign in with Google. Email and password still work. Other devices will be signed out.</p>
            {error && <Banner tone="err">{error}</Banner>}
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <div className="pb-phone-actions">
              <Button type="submit" variant="danger" disabled={!password || busy} loading={busy}>
                {busy ? 'Unlinking…' : 'Unlink Google account'}
              </Button>
              <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
