import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

// Each area owns its folder: ./customer, ./shop, ./admin. Each default-exports a component that
// renders its own nested <Routes> (the parent route here ends in /*).
const CustomerRoutes = lazy(() => import('./customer/CustomerRoutes'));
const ShopRoutes = lazy(() => import('./shop/ShopRoutes'));
const AdminRoutes = lazy(() => import('./admin/AdminRoutes'));

export function App() {
  return (
    <Suspense fallback={<div className="page-loading" role="status">Loading…</div>}>
      <Routes>
        <Route path="/p/*" element={<CustomerRoutes />} />
        <Route path="/t/*" element={<CustomerRoutes />} />
        <Route path="/shop/*" element={<ShopRoutes />} />
        <Route path="/admin/*" element={<AdminRoutes />} />
        <Route path="*" element={<Navigate to="/shop" replace />} />
      </Routes>
    </Suspense>
  );
}
