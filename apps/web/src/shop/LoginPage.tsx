import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { PhoneAuthError, googleAuthErrorMessage, initFirebaseAuth, phoneAuthConfigured, signInWithGoogleWeb } from '../lib/phone-auth';
import { Banner, BrandLogo, Button, Card } from '../ui';
import { useAuth } from './auth';
import { AdminSessionNotice } from './AdminSessionNotice';
import { safeShopRedirect } from './safe-redirect';
import './phone.css';

export function GoogleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  );
}

export function googleLoginError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'GOOGLE_NOT_LINKED': return "This Google account isn't linked to a shop account yet. Continue with Google again to set up your shop, or contact support if you expected an existing shop.";
      case 'GOOGLE_TOKEN_INVALID': return 'We could not verify that Google account. Try again.';
      case 'SHOP_SUSPENDED': case 'SHOP_UNAVAILABLE': return 'This shop account is suspended. Please contact support.';
      case 'GOOGLE_LOGIN_UNAVAILABLE': return 'Google sign-in is unavailable right now. Please try again shortly.';
      case 'RATE_LIMITED': return 'Too many sign-in attempts. Please wait a minute and try again.';
      case 'NETWORK_ERROR': return 'Cannot reach the server. Check your connection and try again.';
    }
    if (e.status === 429) return 'Too many sign-in attempts. Please wait a minute and try again.';
    if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
  }
  if (e instanceof PhoneAuthError) return googleAuthErrorMessage(e);
  return 'Could not sign in with Google. Please try again.';
}

export type Classified = { message: string; restart: boolean };

/** Copy for the phone-token exchange (preserved for identity-linking flows). */
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

export default function LoginPage() {
  const { state, googleLogin } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const from = (loc.state as { from?: string; expired?: boolean } | null)?.from;
  const expired = !!(loc.state as { expired?: boolean } | null)?.expired;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = phoneAuthConfigured();

  useEffect(() => {
    if (configured) initFirebaseAuth().catch(() => undefined);
  }, [configured]);

  // This page never redirects into /admin: administrators sign in only at their own explicit route.
  if (state.status === 'authed' && !busy) {
    if (state.session.user.role === 'PLATFORM_ADMIN') return <AdminSessionNotice />;
    return <Navigate to={safeShopRedirect(from)} replace />;
  }

  async function onGoogleClick() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await signInWithGoogleWeb();
      const s = await googleLogin(idToken);
      if (('nextStep' in s && s.nextStep === 'create_shop') || ('onboarding' in s && s.onboarding) || !s.user?.id) {
        navigate('/shop/register', { replace: true });
        return;
      }
      if (s.user.role === 'PLATFORM_ADMIN') { setBusy(false); return; } // renders the notice above; no redirect
      navigate(safeShopRedirect(from), { replace: true });
    } catch (err) {
      setError(googleLoginError(err));
      setBusy(false);
    }
  }

  return (
    <div className="pb-theme pb-login">
      <div className="pb-login__brand"><BrandLogo /></div>
      <Card as="section" className="pb-login__card">
        <div className="pb-login__form">
          <h1 id="login-title" className="pb-h1">Shop sign in</h1>
          {expired && !error && <Banner tone="warn">Session expired — sign in again.</Banner>}
          {error && <Banner tone="err">{error}</Banner>}
          {!configured && <Banner tone="err">Google sign-in is not available right now. Please try again later.</Banner>}
          <Button
            type="button"
            variant="outline"
            fullWidth
            className="pb-login__google-btn"
            onClick={onGoogleClick}
            disabled={busy || !configured}
            loading={busy}
            data-testid="google-login-btn"
          >
            <GoogleIcon />
            <span>Continue with Google</span>
          </Button>
          <p className="pb-login__recover">
            <Link to="/shop/recover" data-testid="recover-link">Existing account without Google? Recover access</Link>
          </p>
        </div>
      </Card>
    </div>
  );
}
