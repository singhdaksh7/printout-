import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { googleAuthErrorMessage, PhoneAuthError, signInWithGoogleWeb } from '../lib/phone-auth';
import { Banner, BrandLogo, Button, Card, TextField } from '../ui';
import { useAuth } from './auth';
import { GoogleIcon } from './LoginPage';
import './phone.css';

export function recoverError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'INVALID_CREDENTIALS': return 'That email and password do not match a shop owner account. Check them and try again.';
      case 'GOOGLE_IDENTITY_UNAVAILABLE': return 'This Google account is already linked to a different account. Choose another Google account.';
      case 'GOOGLE_ALREADY_LINKED': return 'This account already has a Google account linked. Go back to sign in and continue with Google.';
      case 'GOOGLE_TOKEN_INVALID': return 'We could not verify that Google account. Try again.';
      case 'SHOP_SUSPENDED': return 'This shop account is suspended. Please contact support.';
      case 'GOOGLE_LOGIN_UNAVAILABLE': return 'Google sign-in is unavailable right now. Please try again shortly.';
      case 'RATE_LIMITED': return 'Too many attempts. Please wait a few minutes and try again.';
      case 'NETWORK_ERROR': return 'Cannot reach the server. Check your connection and try again.';
    }
    if (e.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
  }
  if (e instanceof PhoneAuthError) return googleAuthErrorMessage(e);
  return 'Could not recover access. Please try again.';
}

/** One-time recovery for owners who only ever had an email + password: prove the old account, then link a Google account. */
export default function RecoverAccessPage() {
  const { state, recoverWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'authed' && !busy) {
    return <Navigate to={state.session.user.role === 'PLATFORM_ADMIN' ? '/shop/login' : '/shop'} replace />;
  }

  function onNext(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your old email and password.');
      return;
    }
    setError(null);
    setStep(2);
  }

  async function onGoogle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await signInWithGoogleWeb();
      await recoverWithGoogle(email.trim(), password, idToken);
      setPassword('');
      navigate('/shop', { replace: true });
    } catch (err) {
      setError(recoverError(err));
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') setStep(1);
      setBusy(false);
    }
  }

  return (
    <div className="pb-theme pb-login">
      <div className="pb-login__brand"><BrandLogo /></div>
      <Card as="section" className="pb-login__card">
        <div className="pb-login__form">
          <h1 id="recover-title" className="pb-h1">Recover access</h1>
          <p>Shop sign in now uses Google. If you only have an old email and password, confirm them once, then link a Google account. This works for shop owner accounts only.</p>
          <ol className="pb-recover__steps" aria-label="Recovery steps">
            <li aria-current={step === 1 ? 'step' : undefined}><strong>Step 1:</strong> enter your old email and password</li>
            <li aria-current={step === 2 ? 'step' : undefined}><strong>Step 2:</strong> continue with Google</li>
          </ol>
          {error && <Banner tone="err">{error}</Banner>}
          {step === 1 ? (
            <form onSubmit={onNext} className="pb-login__form" noValidate>
              <TextField label="Old email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
              <TextField label="Old password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <Button type="submit" fullWidth>Next</Button>
            </form>
          ) : (
            <>
              <p>Recovering <strong>{email.trim()}</strong>. Now choose the Google account you want to use from here on.</p>
              <Button type="button" variant="outline" fullWidth className="pb-login__google-btn" onClick={onGoogle} disabled={busy} loading={busy} data-testid="recover-google-btn">
                <GoogleIcon />
                <span>Continue with Google</span>
              </Button>
              <Button type="button" variant="ghost" fullWidth onClick={() => { setStep(1); setError(null); }} disabled={busy}>Back</Button>
            </>
          )}
          <p className="pb-login__recover"><Link to="/shop/login">Back to shop sign in</Link></p>
        </div>
      </Card>
    </div>
  );
}
