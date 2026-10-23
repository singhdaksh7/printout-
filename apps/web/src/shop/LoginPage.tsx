import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { phoneAuthConfigured } from '../lib/phone-auth';
import { getPhoneLoginConfig, type PhoneLoginConfig } from '../lib/shop-api';
import { Banner, BrandLogo, Button, Card, Skeleton, TextField } from '../ui';
import { useAuth } from './auth';
import { PhoneVerifier, type Classified } from './PhoneVerifier';
import { safeShopRedirect } from './safe-redirect';
import './phone.css';

function loginErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429 || e.code === 'RATE_LIMITED') return 'Too many sign-in attempts. Please wait a minute and try again.';
    if (e.code === 'NETWORK_ERROR') return 'Cannot reach the server. Check your connection and try again.';
    if (e.code === 'SHOP_UNAVAILABLE' || e.code === 'SHOP_SUSPENDED') return 'This shop account is suspended. Please contact support.';
    if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
  }
  return 'Incorrect email or password.'; // deliberately generic
}

/** Copy for the phone-token exchange. `restart` = the code/token is spent or refused, so the person must start again. */
export function phoneLoginError(e: unknown): Classified {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'PHONE_NOT_LINKED': return { message: "This number isn't linked to a shop account. Sign in with email and password, then link it in Settings.", restart: true };
      case 'PHONE_REVERIFY_REQUIRED': return { message: 'For your security this number needs to be linked again. Sign in with email and password, then link it in Settings.', restart: true };
      case 'PHONE_TOKEN_INVALID': return { message: 'We could not verify that code. Request a new one and try again.', restart: true };
      case 'SHOP_SUSPENDED': case 'SHOP_UNAVAILABLE': return { message: 'This shop account is suspended. Please contact support.', restart: true };
      case 'PHONE_LOGIN_UNAVAILABLE': return { message: 'Phone sign-in is unavailable right now. Use email and password instead.', restart: false };
      case 'RATE_LIMITED': return { message: 'Too many sign-in attempts. Please wait a minute and try again.', restart: false };
      case 'NETWORK_ERROR': return { message: 'Cannot reach the server. Check your connection and try again.', restart: false };
    }
    if (e.status === 429) return { message: 'Too many sign-in attempts. Please wait a minute and try again.', restart: false };
    if (e.status >= 500) return { message: 'The server had a problem. Please try again shortly.', restart: false };
  }
  return { message: 'We could not sign you in with that code. Request a new one and try again.', restart: true };
}

type PhoneState = { status: 'off' } | { status: 'loading' } | { status: 'on'; config: PhoneLoginConfig };

export default function LoginPage() {
  const { state, login, phoneLogin } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const from = (loc.state as { from?: string; expired?: boolean } | null)?.from;
  const expired = !!(loc.state as { expired?: boolean } | null)?.expired;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'phone' | 'email'>('phone');
  const [phone, setPhone] = useState<PhoneState>(() => (phoneAuthConfigured() ? { status: 'loading' } : { status: 'off' }));
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [masked, setMasked] = useState<string | null>(null);

  useEffect(() => {
    if (!phoneAuthConfigured()) return;
    let alive = true;
    getPhoneLoginConfig()
      .then((config) => { if (alive) setPhone(config.enabled ? { status: 'on', config } : { status: 'off' }); })
      .catch(() => { if (alive) setPhone({ status: 'off' }); }); // outage or older API: password sign-in keeps working
    return () => { alive = false; };
  }, []);

  const onStep = useCallback((s: 'phone' | 'code', m: string | null) => { setStep(s); setMasked(m); }, []);

  if (state.status === 'authed' && !busy) {
    if (state.session.user.role === 'PLATFORM_ADMIN') return <Navigate to="/admin" replace />;
    return <Navigate to={safeShopRedirect(from)} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await login(email.trim(), password);
      // An admin who signed in on the shop page with two-factor on: the code step lives on the admin sign-in screen.
      if ('twoFactorRequired' in s) { navigate('/admin/login', { replace: true, state: { resumeTwoFactor: true } }); return; }
      if (s.user.role === 'PLATFORM_ADMIN') navigate('/admin', { replace: true });
      else navigate(safeShopRedirect(from), { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      setBusy(false);
    }
  }

  async function onToken(idToken: string) {
    const s = await phoneLogin(idToken);
    // Phone sign-in never yields an admin session (the API refuses it); guard anyway.
    navigate(s.user.role === 'PLATFORM_ADMIN' ? '/admin' : safeShopRedirect(from), { replace: true });
  }

  const phoneMode = phone.status === 'on' && mode === 'phone';

  return (
    <div className="pb-theme pb-login">
      <div className="pb-login__brand"><BrandLogo /></div>
      <Card as="section" className="pb-login__card">
        {phone.status === 'loading' ? (
          <Skeleton lines={4} label="Loading sign-in options" />
        ) : phoneMode ? (
          <div className="pb-login__form" data-testid="phone-login">
            <div>
              <h1 id="login-title" className="pb-h1">{step === 'phone' ? 'Welcome back' : 'Enter your code'}</h1>
              <p className="pb-muted pb-pagehead__sub">
                {step === 'phone' ? 'Sign in to your print shop with your mobile number.' : masked ? `We sent a 6-digit code to ${masked}.` : ''}
              </p>
            </div>
            {expired && <Banner tone="warn">Session expired — sign in again.</Banner>}
            <PhoneVerifier
              allowedCallingCodes={phone.config.allowedCallingCodes}
              defaultCallingCode={phone.config.defaultCallingCode}
              resendCooldownSeconds={phone.config.resendCooldownSeconds}
              onToken={onToken}
              classify={phoneLoginError}
              onStep={onStep}
              verifyLabel="Verify OTP"
              idPrefix="login"
            />
            <Button type="button" variant="ghost" fullWidth onClick={() => { setMode('email'); setError(null); }}>
              Sign in with email and password instead
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} aria-labelledby="login-title" noValidate className="pb-login__form">
            <div>
              <h1 id="login-title" className="pb-h1">Shop sign in</h1>
              <p className="pb-muted pb-pagehead__sub">Printout for print shops</p>
            </div>
            {expired && !error && <Banner tone="warn">Session expired — sign in again.</Banner>}
            {error && <Banner tone="err">{error}</Banner>}
            <TextField label="Email" type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
            <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            <Button type="submit" variant="primary" fullWidth disabled={busy || !email || !password} loading={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            {phone.status === 'on' && (
              <Button type="button" variant="ghost" fullWidth onClick={() => { setMode('phone'); setError(null); }} disabled={busy}>
                Sign in with mobile number instead
              </Button>
            )}
          </form>
        )}
      </Card>
    </div>
  );
}
