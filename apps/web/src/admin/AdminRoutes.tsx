import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../shop/auth';
import AuditPage from './AuditPage';
import DashboardPage from './DashboardPage';
import LoginPage from './LoginPage';
import PlansPage from './PlansPage';
import ShopDetailPage from './ShopDetailPage';
import Shell, { RequireAdmin } from './Shell';
import { CreateShop, ShopsList } from './ShopsPage';
import '../shop/shop.css';
import './admin.css';

class AdminErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Admin area crashed', error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="shop-boot" role="alert"><p>Something went wrong.</p><button className="sh-btn" onClick={() => location.reload()}>Reload</button></div>;
  }
}

// Mounted by App at /admin/*; paths below are relative to that.
export default function AdminRoutes() {
  return (
    <AdminErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route element={<RequireAdmin><Shell /></RequireAdmin>}>
            <Route index element={<DashboardPage />} />
            <Route path="shops" element={<ShopsList />} />
            <Route path="shops/new" element={<CreateShop />} />
            <Route path="shops/:id" element={<ShopDetailPage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="audit" element={<AuditPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </AuthProvider>
    </AdminErrorBoundary>
  );
}
