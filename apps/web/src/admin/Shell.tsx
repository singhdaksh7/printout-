import { useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../shop/auth';
import { AppShell, BottomNav, Button, Chip, Sidebar, TopBar, type NavItem } from '../ui';

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  const loc = useLocation();
  if (state.status === 'loading') return <div className="shop-boot" role="status" aria-live="polite">Loading…</div>;
  if (state.status === 'error') {
    return <div className="shop-boot pb-theme" role="alert"><p>{state.message}</p><Button variant="outline" onClick={retry}>Try again</Button></div>;
  }
  if (state.status === 'anon') {
    return <Navigate to="/admin/login" replace state={{ from: loc.pathname + loc.search, expired: !!state.expired }} />;
  }
  if (state.session.user.role !== 'PLATFORM_ADMIN') return <Navigate to="/shop" replace />;
  return <>{children}</>;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/admin', label: 'Dashboard', end: true, icon: 'layout-dashboard' },
  { to: '/admin/shops', label: 'Shops', icon: 'store' },
  { to: '/admin/orders', label: 'Orders', icon: 'list-ordered' },
  { to: '/admin/subscriptions', label: 'Subscriptions', icon: 'credit-card' },
  { to: '/admin/plans', label: 'Plans', icon: 'receipt' },
  { to: '/admin/audit', label: 'Audit log', icon: 'scroll-text' },
  { to: '/admin/account', label: 'Account', icon: 'lock' }
];
/** Phone tab bar: Plans is reached from the Subscriptions page so that five labels fit 360px. */
const PHONE_PATHS = ['/admin', '/admin/shops', '/admin/orders', '/admin/subscriptions', '/admin/audit'];

export default function Shell() {
  const { state, logout } = useAuth();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const name = state.status === 'authed' ? state.session.user.displayName : '';
  async function out() {
    setLeaving(true);
    await logout();
    navigate('/admin/login', { replace: true });
  }
  return (
    <AppShell
      sidebar={<Sidebar label="Admin sections" brand={<span className="pb-brandmark">PrintoutBuddy<small className="ad-brandsub">Platform admin</small></span>} items={NAV_ITEMS} />}
      topbar={
        <TopBar
          start={<Chip tone="info" dot={false}>Platform admin</Chip>}
          end={<>
            <Link to="/admin/account" className="pb-shopname ad-accountlink" title={name} aria-label={`Account settings for ${name}`}>{name}</Link>
            <Button variant="outline" size="sm" iconStart="log-out" onClick={out} disabled={leaving}>Log out</Button>
          </>}
        />
      }
      bottomNav={<BottomNav label="Admin sections, phone" items={NAV_ITEMS.filter((i) => PHONE_PATHS.includes(i.to))} />}
    >
      <div className="pb-page pb-theme"><Outlet /></div>
    </AppShell>
  );
}
