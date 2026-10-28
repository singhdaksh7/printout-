import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { BrandLogo, Button, Skeleton } from '../ui';
import './market.css';
import { LoginPage, NearbyPage, ShopPage, WelcomePage } from './browse';
import { NotificationsPage, OrderFlowPage, OrderPage, OrdersPage } from './orders';
import { MarketProvider, useMarket } from './session';

/** Marketplace customers (feature-flagged: VITE_MARKETPLACE=1). Mounted by App at /app/*. */
export const MARKETPLACE_ENABLED = import.meta.env.VITE_MARKETPLACE === '1';

function Gate({ children }: { children: JSX.Element }) {
  const { state } = useMarket();
  const loc = useLocation();
  if (state.status === 'loading') return <div className="mk-page"><Skeleton variant="block" height={120} /></div>;
  if (state.status === 'onboarding') return <Navigate to="/app/welcome" replace />;
  if (state.status === 'anon') return <Navigate to="/app/login" replace state={{ from: loc.pathname }} />;
  return children;
}

function Shell() {
  const { state, signOut } = useMarket();
  return (
    <div className="pb-theme mk-root">
      <header className="mk-bar">
        <BrandLogo />
        {state.status === 'authed' && (
          <nav aria-label="Customer" className="mk-nav">
            <NavLink to="/app" end>Shops</NavLink>
            <NavLink to="/app/orders">Orders</NavLink>
            <NavLink to="/app/notifications">Alerts</NavLink>
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>Sign out</Button>
          </nav>
        )}
      </header>
      <main>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route path="welcome" element={<WelcomePage />} />
          <Route index element={<Gate><NearbyPage /></Gate>} />
          <Route path="shops/:id" element={<Gate><ShopPage /></Gate>} />
          <Route path="shops/:id/order" element={<Gate><OrderFlowPage /></Gate>} />
          <Route path="orders" element={<Gate><OrdersPage /></Gate>} />
          <Route path="orders/:id" element={<Gate><OrderPage /></Gate>} />
          <Route path="notifications" element={<Gate><NotificationsPage /></Gate>} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function MarketRoutes() {
  return (
    <MarketProvider>
      <Shell />
    </MarketProvider>
  );
}
