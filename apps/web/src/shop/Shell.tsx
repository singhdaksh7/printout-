import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { listOrders } from '../lib/shop-api';
import { useAuth } from './auth';
import { AppShell, Banner, BottomNav, BrandLogo, Button, Chip, Sidebar, TopBar, type ChipTone, type NavItem } from '../ui';
import { ShopErrorBoundary, UnsavedContext, UNSAVED_PROMPT } from './components';
import { useAutoRefresh, useDebounced } from './hooks';
import { useRealtime, useRealtimeRefresh } from './realtime';

/** Sidebar (desktop and tablet) destinations. Staff and Reports have no backend yet, so they are labelled Coming soon and are not links. */
const NAV_ITEMS: NavItem[] = [
  { to: '/shop', label: 'Print queue', shortLabel: 'Queue', end: true, icon: 'list-ordered' },
  { to: '/shop/history', label: 'History', icon: 'clock' },
  { to: '/shop/analytics', label: 'Analytics', icon: 'chart-column' },
  { to: '/shop/devices', label: 'Devices', icon: 'printer' },
  { to: '/shop/pricing', label: 'Rate card', icon: 'indian-rupee' },
  { to: '/shop/qr', label: 'QR & standee', icon: 'qr-code' },
  { to: '/shop/settings', label: 'Settings', icon: 'settings' },
  { to: '/shop/staff', label: 'Staff', icon: 'users', comingSoon: true },
  { to: '/shop/reports', label: 'Reports', icon: 'receipt', comingSoon: true }
];
/** Phone tab bar: five destinations stay visible; the rest (QR & standee, Settings) live under "More", so nothing is hidden or reachable only by a side link. */
const PHONE_PATHS = ['/shop', '/shop/history', '/shop/analytics', '/shop/devices', '/shop/pricing'];

const CONN_LABEL = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline' } as const;
const CONN_TONE: Record<keyof typeof CONN_LABEL, ChipTone> = { live: 'ok', connecting: 'warn', reconnecting: 'warn', offline: 'err' };

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
  const items = NAV_ITEMS.map((i) => (i.to === '/shop' ? { ...i, count: newCount } : i));
  const phoneItems = items.filter((i) => PHONE_PATHS.includes(i.to));
  const moreItems = items.filter((i) => !PHONE_PATHS.includes(i.to));
  return (
    <UnsavedContext.Provider value={guard}>
      <AppShell
        notice={(!online || conn === 'offline') ? <Banner tone="warn" layout="bar">You are offline. Orders may be out of date until the connection returns.</Banner> : undefined}
        sidebar={<Sidebar label="Shop sections" brand={<BrandLogo onDark />} items={items} onNavigate={onNavClick} />}
        topbar={
          <TopBar
            start={<span className="pb-shopname" title={shopName}>{shopName}</span>}
            end={<>
              <Chip tone={CONN_TONE[conn]} className="shop-conn" role="status" aria-live="polite" aria-label={`Connection: ${CONN_LABEL[conn]}`}>{CONN_LABEL[conn]}</Chip>
              <Button variant="outline" size="sm" iconStart="log-out" onClick={doLogout} disabled={leaving}>Log out</Button>
            </>}
          />
        }
        bottomNav={<BottomNav label="Shop sections, phone" items={phoneItems} moreItems={moreItems} onNavigate={onNavClick} />}
      >
        <ShopErrorBoundary><Outlet /></ShopErrorBoundary>
      </AppShell>
    </UnsavedContext.Provider>
  );
}
