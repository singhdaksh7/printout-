import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth';
import { ShopErrorBoundary } from './components';
import { RealtimeProvider } from './realtime';
import Shell from './Shell';
import LoginPage from './LoginPage';
import RegisterShopPage from './RegisterShopPage';
import QueuePage from './QueuePage';
import OrderDetailPage from './OrderDetailPage';
import PricingPage from './PricingPage';
import QrPage from './QrPage';
import AnalyticsPage from './AnalyticsPage';
import HistoryPage from './HistoryPage';
import SettingsPage from './SettingsPage';
import DevicesPage from './DevicesPage';
import { Skeleton } from '../ui';
import './shop.css';

// The poster generator (PDF writer) is only needed on its own page, so it loads on demand.
const PosterPage = lazy(() => import('./poster/PosterPage'));

// Mounted by App at /shop/*; paths below are relative to that.
export default function ShopRoutes() {
  return (
    <ShopErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterShopPage />} />
          <Route element={<RequireAuth><RealtimeProvider><Shell /></RealtimeProvider></RequireAuth>}>
            <Route index element={<QueuePage />} />
            <Route path="orders/:id" element={<OrderDetailPage />} />
            <Route path="pricing" element={<PricingPage />} />
            <Route path="qr" element={<QrPage />} />
            <Route path="qr/poster" element={<Suspense fallback={<Skeleton lines={6} label="Loading poster generator" />}><PosterPage /></Suspense>} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="devices" element={<DevicesPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/shop" replace />} />
        </Routes>
      </AuthProvider>
    </ShopErrorBoundary>
  );
}
