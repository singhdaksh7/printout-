import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { isTwoFactorRequired, type SecondFactorMethod } from '../lib/shop-api';
import { useAuth } from '../shop/auth';
import { Banner, BrandLogo, Button, Card, TextField } from '../ui';

function loginErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429 || e.code === 'RATE_LIMITED') return 'Too many sign-in attempts. Please wait a minute and try again.';
    if (e.code === 'NETWORK_ERROR') return e.message;
    if (e.code === 'TWO_FACTOR_UNAVAILABLE') return 'Two-step verification is unavailable on this server right now. Contact the platform operator.';
    if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
  }
  return 'Incorrect email or password.';
}

type CodeError = { message: string; backToPassword?: boolean };
function codeErrorMessage(e: unknown, method: SecondFactorMethod): CodeError {
  if (e instanceof ApiError) {
    if (e.code === 'TWO_FACTOR_CHALLENGE_INVALID') return { message: 'Your sign-in expired. Enter your password again.', backToPassword: true };
    if (e.status === 429 || e.code === 'RATE_LIMITED') return { message: 'Too many incorrect codes. Wait a few minutes before trying again.' };
    if (e.code === 'NETWORK_ERROR') return { message: e.message };
    if (e.code === 'TWO_FACTOR_UNAVAILABLE') return { message: 'Two-step verification is unavailable on this server right now. Contact the platform operator.' };
    if (e.status >= 500) return { message: 'The server had a problem. Please try again shortly.' };
  }
  return { message: method === 'totp' ? 'That code is not valid. Check your authenticator app and try again.' : 'That recovery code is not valid or was already used.' };
}

export default function LoginPage() {
  const { state, login, completeSecondFactor, cancelSecondFactor } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const nav = loc.state as { from?: string; expired?: boolean; credentialsChanged?: 'email' | 'password'; resumeTwoFactor?: boolean } | null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'password' | 'code'>(nav?.resumeTwoFactor ? 'code' : 'password');
  const [method, setMethod] = useState<SecondFactorMethod>('totp');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const dest = nav?.from && nav.from.startsWith('/admin') && !nav.from.startsWith('/admin/login') ? nav.from : '/admin';

  // Move focus to the field the person needs next whenever the step or method changes (keyboard and screen-reader users).
  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step, method]);
  useEffect(() => {
    if (!busy && error && step === 'code') codeRef.current?.focus();
  }, [busy, error, step]);

  if (state.status === 'authed' && !busy) {
    return <Navigate to={state.session.user.role === 'PLATFORM_ADMIN' ? dest : '/shop'} replace />;
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await login(email.trim(), password);
      if (isTwoFactorRequired(s)) {
        setPassword(''); // the password is not needed again; do not keep it in memory longer than necessary
        setCode('');
        setMethod('totp');
        setStep('code');
        setBusy(false);
        return;
      }
      navigate(s.user.role === 'PLATFORM_ADMIN' ? dest : '/shop', { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!code.trim()) {
      setError(method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes.');
      codeRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await completeSecondFactor(method, code.trim());
      if (method === 'recovery') navigate('/admin/account', { replace: true, state: { recoveryUsed: s.recoveryCodesRemaining ?? 0 } });
      else navigate(dest, { replace: true });
    } catch (err) {
      const m = codeErrorMessage(err, method);
      if (m.backToPassword) {
        setStep('password');
        setCode('');
        setBusy(false);
        setError(m.message);
        setTimeout(() => passwordRef.current?.focus(), 0);
        return;
      }
      setError(m.message);
      setCode('');
      setBusy(false);
    }
  }

  async function back() {
    setBusy(true);
    await cancelSecondFactor();
    setStep('password');
    setCode('');
    setError(null);
    setBusy(false);
    setTimeout(() => passwordRef.current?.focus(), 0);
  }

  function switchMethod() {
    setMethod((m) => (m === 'totp' ? 'recovery' : 'totp'));
    setCode('');
    setError(null);
  }

  return (
    <div className="pb-theme pb-login">
      <div className="pb-login__brand"><BrandLogo /></div>
      <Card as="section" className="pb-login__card">
        {step === 'password' ? (
          <form onSubmit={submitPassword} aria-labelledby="ad-login-title" noValidate className="pb-login__form">
            <div>
              <h1 id="ad-login-title" className="pb-h1">Admin sign in</h1>
              <p className="pb-muted pb-pagehead__sub">Printout platform administration</p>
            </div>
            {nav?.credentialsChanged && !error && (
              <Banner tone="ok">Your {nav.credentialsChanged} was changed and you were signed out on all devices. Sign in again{nav.credentialsChanged === 'email' ? ' with your new email' : ' with your new password'}.</Banner>
            )}
            {nav?.expired && !error && !nav.credentialsChanged && <Banner tone="warn">Session expired — sign in again.</Banner>}
            {error && <Banner tone="err">{error}</Banner>}
            <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
            <TextField ref={passwordRef} label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            <Button type="submit" variant="primary" fullWidth disabled={busy || !email || !password} loading={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
        ) : (
          <form onSubmit={submitCode} aria-labelledby="ad-2fa-title" noValidate className="pb-login__form">
            <div>
              <h1 id="ad-2fa-title" className="pb-h1">Two-step verification</h1>
              <p className="pb-muted pb-pagehead__sub">
                {method === 'totp'
                  ? 'Open your authenticator app and enter the 6-digit code for Printout Buddy.'
                  : 'Enter one of the recovery codes you saved when you set up two-step verification. Each code works once.'}
              </p>
            </div>
            {error && <Banner tone="err">{error}</Banner>}
            {method === 'totp' ? (
              <TextField
                ref={codeRef}
                key="totp"
                label="Authentication code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={7}
                mono
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))}
                disabled={busy}
                required
              />
            ) : (
              <TextField
                ref={codeRef}
                key="recovery"
                label="Recovery code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={14}
                mono
                helperText="Format: XXXXX-XXXXX"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                disabled={busy}
                required
              />
            )}
            <Button type="submit" variant="primary" fullWidth disabled={busy || !code.trim()} loading={busy}>{busy ? 'Verifying…' : 'Verify and sign in'}</Button>
            <div className="ad-actions ad-actions--split">
              <Button type="button" variant="ghost" onClick={switchMethod} disabled={busy}>
                {method === 'totp' ? 'Use a recovery code' : 'Use my authenticator app'}
              </Button>
              <Button type="button" variant="ghost" onClick={back} disabled={busy}>Back to sign in</Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
