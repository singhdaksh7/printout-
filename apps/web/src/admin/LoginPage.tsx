import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../shop/auth';

function loginErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429 || e.code === 'RATE_LIMITED') return 'Too many sign-in attempts. Please wait a minute and try again.';
    if (e.code === 'NETWORK_ERROR') return e.message;
    if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
  }
  return 'Incorrect email or password.';
}

export default function LoginPage() {
  const { state, login } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const nav = loc.state as { from?: string; expired?: boolean } | null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dest = nav?.from && nav.from.startsWith('/admin') && !nav.from.startsWith('/admin/login') ? nav.from : '/admin';

  if (state.status === 'authed' && !busy) {
    return <Navigate to={state.session.user.role === 'PLATFORM_ADMIN' ? dest : '/shop'} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await login(email.trim(), password);
      navigate(s.user.role === 'PLATFORM_ADMIN' ? dest : '/shop', { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="ad-login">
      <form className="ad-login-card" onSubmit={submit} aria-labelledby="ad-login-title" noValidate>
        <h1 id="ad-login-title">Admin sign in</h1>
        <p className="sh-muted">Printout platform administration</p>
        {nav?.expired && !error && <div className="sh-banner sh-banner-warn" role="status">Session expired — sign in again.</div>}
        {error && <div className="sh-banner sh-banner-error" role="alert">{error}</div>}
        <label className="sh-field"><span>Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} /></label>
        <label className="sh-field"><span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>
        <button className="sh-btn sh-btn-primary sh-btn-block" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
