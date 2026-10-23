import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError, setCsrfToken } from '../lib/api';
import {
  cancelSecondFactor as apiCancelSecondFactor, fetchSession, isTwoFactorRequired, login as apiLogin, logout as apiLogout, setUnauthorizedHandler,
  phoneSession as apiPhoneSession, googleSession as apiGoogleSession, verifySecondFactor as apiVerifySecondFactor, type LoginResult, type SecondFactorMethod, type SessionData
} from '../lib/shop-api';
import { Button } from '../ui';

type AuthState =
  | { status: 'loading' }
  | { status: 'anon'; expired?: boolean }
  | { status: 'error'; message: string }
  | { status: 'authed'; session: SessionData };

interface AuthApi {
  state: AuthState;
  /** Resolves with a session, or with `twoFactorRequired` when an admin must still enter a code (no session exists yet). */
  login(email: string, password: string): Promise<LoginResult>;
  /** Signs in with a Firebase phone ID token (server verifies it and resolves the linked shop account). */
  phoneLogin(idToken: string): Promise<SessionData>;
  /** Signs in with a Firebase Google ID token (server verifies it and resolves the linked shop account). */
  googleLogin(idToken: string): Promise<SessionData>;
  /** Completes a pending admin sign-in with an authenticator or recovery code. */
  completeSecondFactor(method: SecondFactorMethod, code: string): Promise<SessionData & { recoveryCodesRemaining?: number }>;
  /** Abandons the pending second-factor step. */
  cancelSecondFactor(): Promise<void>;
  logout(): Promise<void>;
  /** Drops the local session WITHOUT calling the API (the server already ended it, e.g. after a credential change). */
  endSession(): void;
  retry(): void;
}
const Ctx = createContext<AuthApi | null>(null);
export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    fetchSession()
      .then((s) => { if (!alive) return; setCsrfToken(s.csrfToken); setState({ status: 'authed', session: s }); })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) { setCsrfToken(null); setState({ status: 'anon' }); }
        else setState({ status: 'error', message: e instanceof ApiError && e.code === 'NETWORK_ERROR' ? e.message : 'Could not load your session. Please try again.' });
      });
    return () => { alive = false; };
  }, [attempt]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setState((s) => (s.status === 'authed' ? { status: 'anon', expired: true } : s));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const s = await apiLogin(email, password);
    if (isTwoFactorRequired(s)) return s; // not signed in yet
    setCsrfToken(s.csrfToken);
    setState({ status: 'authed', session: s });
    return s;
  }, []);
  const phoneLogin = useCallback(async (idToken: string) => {
    const s = await apiPhoneSession(idToken);
    setCsrfToken(s.csrfToken);
    setState({ status: 'authed', session: s });
    return s;
  }, []);
  const googleLogin = useCallback(async (idToken: string) => {
    const s = await apiGoogleSession(idToken);
    setCsrfToken(s.csrfToken);
    setState({ status: 'authed', session: s });
    return s;
  }, []);
  const completeSecondFactor = useCallback(async (method: SecondFactorMethod, code: string) => {
    const s = await apiVerifySecondFactor(method, code);
    setCsrfToken(s.csrfToken);
    setState({ status: 'authed', session: s });
    return s;
  }, []);
  const cancelSecondFactor = useCallback(async () => {
    try { await apiCancelSecondFactor(); } catch { /* the challenge expires by itself */ }
  }, []);
  const logout = useCallback(async () => {
    try { await apiLogout(); } catch { /* cookie may already be invalid; clear locally regardless */ }
    setCsrfToken(null);
    setState({ status: 'anon' });
  }, []);
  const endSession = useCallback(() => { setCsrfToken(null); setState({ status: 'anon' }); }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo(() => ({ state, login, phoneLogin, googleLogin, completeSecondFactor, cancelSecondFactor, logout, endSession, retry }), [state, login, phoneLogin, googleLogin, completeSecondFactor, cancelSecondFactor, logout, endSession, retry]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Gate: renders children only for an authenticated shop user. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <div className="shop-boot" role="status" aria-live="polite">Loading…</div>;
  if (state.status === 'error') {
    return (
      <div className="shop-boot pb-theme" role="alert">
        <p>{state.message}</p>
        <Button variant="outline" onClick={retry}>Try again</Button>
      </div>
    );
  }
  if (state.status === 'anon') {
    const from = location.pathname + location.search;
    return <Navigate to="/shop/login" replace state={{ from, expired: !!state.expired }} />;
  }
  if (state.session.user.role === 'PLATFORM_ADMIN') return <Navigate to="/admin" replace />;
  return <>{children}</>;
}
