import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
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
      if (s.user.role === 'PLATFORM_ADMIN') navigate('/admin', { replace: true });
      else navigate(from && from.startsWith('/shop') && !from.startsWith('/shop/login') ? from : '/shop', { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="shop-login">
      <form className="shop-login-card" onSubmit={submit} aria-labelledby="login-title" noValidate>
        <h1 id="login-title">Shop sign in</h1>
        <p className="sh-muted">Printout for print shops</p>
        {expired && !error && <div className="sh-banner sh-banner-warn" role="status">Session expired — sign in again.</div>}
        {error && <div className="sh-banner sh-banner-error" role="alert">{error}</div>}
        <label className="sh-field">
          <span>Email</span>
          <input type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </label>
        <label className="sh-field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        </label>
        <button className="sh-btn sh-btn-primary sh-btn-block" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
