import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../shop/auth';
import { Banner, Button, Card, TextField } from '../ui';

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
  const nav = loc.state as { from?: string; expired?: boolean; credentialsChanged?: 'email' | 'password' } | null;
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
    <div className="pb-theme pb-login">
      <Card as="section" className="pb-login__card">
        <form onSubmit={submit} aria-labelledby="ad-login-title" noValidate className="pb-login__form">
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
          <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          <Button type="submit" variant="primary" fullWidth disabled={busy || !email || !password} loading={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        </form>
      </Card>
    </div>
  );
}
