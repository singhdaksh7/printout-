import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth';
import { ShopErrorBoundary } from './components';
import { RealtimeProvider } from './realtime';
import Shell from './Shell';
import LoginPage from './LoginPage';
import QueuePage from './QueuePage';
import OrderDetailPage from './OrderDetailPage';
import PricingPage from './PricingPage';
import QrPage from './QrPage';
import AnalyticsPage from './AnalyticsPage';
import SettingsPage from './SettingsPage';
import './shop.css';

// Mounted by App at /shop/*; paths below are relative to that.
export default function ShopRoutes() {
  return (
    <ShopErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route element={<RequireAuth><RealtimeProvider><Shell /></RealtimeProvider></RequireAuth>}>
            <Route index element={<QueuePage />} />
            <Route path="orders/:id" element={<OrderDetailPage />} />
            <Route path="pricing" element={<PricingPage />} />
            <Route path="qr" element={<QrPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/shop" replace />} />
        </Routes>
      </AuthProvider>
    </ShopErrorBoundary>
  );
}
