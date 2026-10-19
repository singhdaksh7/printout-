import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { Banner, BrandLogo, Button, Card, TextField } from '../ui';
import { useAuth } from './auth';

function loginErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429 || e.code === 'RATE_LIMITED') return 'Too many sign-in attempts. Please wait a minute and try again.';
    if (e.code === 'NETWORK_ERROR') return 'Cannot reach the server. Check your connection and try again.';
    if (e.code === 'SHOP_UNAVAILABLE' || e.code === 'SHOP_SUSPENDED') return 'This shop account is suspended. Please contact support.';
    if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
  }
  return 'Incorrect email or password.'; // deliberately generic
}

export default function LoginPage() {
  const { state, login } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const from = (loc.state as { from?: string; expired?: boolean } | null)?.from;
  const expired = !!(loc.state as { expired?: boolean } | null)?.expired;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'authed' && !busy) {
    if (state.session.user.role === 'PLATFORM_ADMIN') return <Navigate to="/admin" replace />;
    return <Navigate to={from && from.startsWith('/shop') && !from.startsWith('/shop/login') ? from : '/shop'} replace />;
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
      else navigate(from && from.startsWith('/shop') && !from.startsWith('/shop/login') ? from : '/shop', { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="pb-theme pb-login">
      <div className="pb-login__brand"><BrandLogo /></div>
      <Card as="section" className="pb-login__card">
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
        </form>
      </Card>
    </div>
  );
}
