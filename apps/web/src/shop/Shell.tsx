import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { listOrders } from '../lib/shop-api';
import { useAuth } from './auth';
import { Banner, ShopErrorBoundary, UnsavedContext, UNSAVED_PROMPT } from './components';
import { useAutoRefresh, useDebounced } from './hooks';
import { useRealtime, useRealtimeRefresh } from './realtime';

const NAV = [
  { to: '/shop', label: 'Queue', end: true, icon: 'M4 6h16M4 12h16M4 18h10' },
  { to: '/shop/pricing', label: 'Pricing', end: false, icon: 'M12 3v18M16 7.5c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 2.5 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3' },
  { to: '/shop/qr', label: 'QR', end: false, icon: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h3v3h-3zM19 19h1' },
  { to: '/shop/analytics', label: 'Analytics', end: false, icon: 'M5 20V10M12 20V4M19 20v-7' },
  { to: '/shop/settings', label: 'Settings', end: false, icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12h2M3 12h2M12 3v2M12 19v2' }
];

const CONN_LABEL = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline' } as const;

function useNewOrderBadge() {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    listOrders({ status: 'NEW' }).then((p) => setCount(p.items.length)).catch(() => { /* badge is best effort */ });
  }, []);
  useEffect(load, [load]);
  const debounced = useDebounced(load, 400);
  useRealtimeRefresh(debounced);
  useAutoRefresh(load, 60_000);
  useEffect(() => {
    document.title = count > 0 ? `(${count}) Printout` : 'Printout';
    return () => { document.title = 'Printout'; };
  }, [count]);
  return count;
}

export default function Shell() {
  const { state, logout } = useAuth();
  const { state: conn } = useRealtime();
  const navigate = useNavigate();
  const newCount = useNewOrderBadge();
  const dirty = useRef(new Set<string>());
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const guard = useMemo(() => ({
    setDirty: (k: string, d: boolean) => { if (d) dirty.current.add(k); else dirty.current.delete(k); },
    isDirty: () => dirty.current.size > 0
  }), []);
  const onNavClick = (e: React.MouseEvent) => {
    if (dirty.current.size > 0 && !window.confirm(UNSAVED_PROMPT)) e.preventDefault();
  };
  async function doLogout() {
    if (dirty.current.size > 0 && !window.confirm(UNSAVED_PROMPT)) return;
    setLeaving(true);
    await logout();
    navigate('/shop/login', { replace: true });
  }

  const shopName = state.status === 'authed' ? (state.session.shop?.displayName ?? 'Printout') : 'Printout';
  return (
    <UnsavedContext.Provider value={guard}>
      <div className="shop-shell">
        <header className="shop-chrome shop-header">
          <div className="shop-header-name" title={shopName}>{shopName}</div>
          <div className={`shop-conn shop-conn-${conn}`} role="status" aria-live="polite" aria-label={`Connection: ${CONN_LABEL[conn]}`}>
            <span className="shop-conn-dot" aria-hidden="true" />{CONN_LABEL[conn]}
          </div>
          <button className="sh-btn sh-btn-sm" onClick={doLogout} disabled={leaving}>Log out</button>
        </header>
        <nav className="shop-chrome shop-nav" aria-label="Shop sections">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} onClick={onNavClick} className={({ isActive }) => `shop-nav-link${isActive ? ' active' : ''}`}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={n.icon} /></svg>
              <span>{n.label}</span>
              {n.label === 'Queue' && newCount > 0 && <span className="shop-nav-badge" aria-label={`${newCount} new orders`}>{newCount}</span>}
            </NavLink>
          ))}
        </nav>
        <main className="shop-main" id="shop-main">
          {(!online || conn === 'offline') && <Banner kind="warn">You are offline. Orders may be out of date until the connection returns.</Banner>}
          <ShopErrorBoundary><Outlet /></ShopErrorBoundary>
        </main>
      </div>
    </UnsavedContext.Provider>
  );
}
