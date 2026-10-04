import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError, setCsrfToken } from '../lib/api';
import { fetchSession, login as apiLogin, logout as apiLogout, setUnauthorizedHandler, type SessionData } from '../lib/shop-api';

type AuthState =
  | { status: 'loading' }
  | { status: 'anon'; expired?: boolean }
  | { status: 'error'; message: string }
  | { status: 'authed'; session: SessionData };

interface AuthApi {
  state: AuthState;
  login(email: string, password: string): Promise<SessionData>;
  logout(): Promise<void>;
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
    setCsrfToken(s.csrfToken);
    setState({ status: 'authed', session: s });
    return s;
  }, []);
  const logout = useCallback(async () => {
    try { await apiLogout(); } catch { /* cookie may already be invalid; clear locally regardless */ }
    setCsrfToken(null);
    setState({ status: 'anon' });
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo(() => ({ state, login, logout, retry }), [state, login, logout, retry]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Gate: renders children only for an authenticated shop user. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <div className="shop-boot" role="status" aria-live="polite">Loading…</div>;
  if (state.status === 'error') {
    return (
      <div className="shop-boot" role="alert">
        <p>{state.message}</p>
        <button className="sh-btn" onClick={retry}>Try again</button>
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
