import { useState, type ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../shop/auth';

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  const loc = useLocation();
  if (state.status === 'loading') return <div className="shop-boot" role="status" aria-live="polite">Loading…</div>;
  if (state.status === 'error') {
    return <div className="shop-boot" role="alert"><p>{state.message}</p><button className="sh-btn" onClick={retry}>Try again</button></div>;
  }
  if (state.status === 'anon') {
    return <Navigate to="/admin/login" replace state={{ from: loc.pathname + loc.search, expired: !!state.expired }} />;
  }
  if (state.session.user.role !== 'PLATFORM_ADMIN') return <Navigate to="/shop" replace />;
  return <>{children}</>;
}

const NAV = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/shops', label: 'Shops', end: false },
  { to: '/admin/orders', label: 'Orders', end: false },
  { to: '/admin/subscriptions', label: 'Subscriptions', end: false },
  { to: '/admin/plans', label: 'Plans', end: false },
  { to: '/admin/audit', label: 'Audit log', end: false }
];

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
    <div className="ad-shell">
      <header className="ad-header">
        <div className="ad-brand">Printout Admin</div>
        <span className="sh-muted sh-ellip" style={{ maxWidth: '40vw' }}>{name}</span>
        <button className="sh-btn sh-btn-sm" onClick={out} disabled={leaving}>Log out</button>
      </header>
      <nav className="ad-nav" aria-label="Admin sections">
        {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>{n.label}</NavLink>)}
      </nav>
      <main className="ad-main" id="admin-main"><Outlet /></main>
    </div>
  );
}
