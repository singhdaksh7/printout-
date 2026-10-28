import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { signInWithGoogleWeb } from '../lib/phone-auth';
import { customerGoogleSession, logout as apiLogout, myProfile, refreshCsrf, registerCustomer, type Profile } from './api';

export type MarketState = { status: 'loading' } | { status: 'anon' } | { status: 'onboarding' } | { status: 'authed'; profile: Profile };

interface Ctx {
  state: MarketState;
  /** Google popup -> server session. Resolves to where the app should go next. */
  signIn(): Promise<'home' | 'welcome'>;
  register(name: string): Promise<void>;
  signOut(): Promise<void>;
}
const MarketCtx = createContext<Ctx | null>(null);

export function MarketProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MarketState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    myProfile()
      .then(async (p) => {
        if (!alive) return;
        if (p) {
          await refreshCsrf().catch(() => undefined);
          if (alive) setState({ status: 'authed', profile: p });
        } else setState({ status: 'anon' });
      })
      .catch(() => alive && setState({ status: 'anon' }));
    return () => { alive = false; };
  }, []);

  const signIn = useCallback(async () => {
    const idToken = await signInWithGoogleWeb();
    const p = await customerGoogleSession(idToken);
    if (p.nextStep === 'create_customer') {
      setState({ status: 'onboarding' });
      return 'welcome' as const;
    }
    setState({ status: 'authed', profile: p });
    return 'home' as const;
  }, []);

  const register = useCallback(async (name: string) => {
    const p = await registerCustomer(name);
    setState({ status: 'authed', profile: p });
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout().catch(() => undefined);
    setState({ status: 'anon' });
  }, []);

  const value = useMemo(() => ({ state, signIn, register, signOut }), [state, signIn, register, signOut]);
  return <MarketCtx.Provider value={value}>{children}</MarketCtx.Provider>;
}

export function useMarket(): Ctx {
  const c = useContext(MarketCtx);
  if (!c) throw new Error('useMarket outside MarketProvider');
  return c;
}
