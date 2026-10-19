import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrandMark } from './ui/navigation/navigation';

// Each area owns its folder: ./customer, ./shop, ./admin. Each default-exports a component that
// renders its own nested <Routes> (the parent route here ends in /*).
const CustomerRoutes = lazy(() => import('./customer/CustomerRoutes'));
const ShopRoutes = lazy(() => import('./shop/ShopRoutes'));
const AdminRoutes = lazy(() => import('./admin/AdminRoutes'));
// Component showcase: development only. `import.meta.env.DEV` is a build-time constant, so the dynamic import
// (and the whole ui/showcase chunk) is dropped from production bundles.
const UiShowcase = import.meta.env.DEV ? lazy(() => import('./ui/showcase/ComponentShowcase')) : null;

/** Shown while a lazy area downloads: the brand mark with a visible label (not colour or motion alone). */
function RouteLoading() {
  return (
    <div className="page-loading" role="status">
      <BrandMark size={48} variant="simple" />
      <span>Loading…</span>
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/p/*" element={<CustomerRoutes />} />
        <Route path="/t/*" element={<CustomerRoutes />} />
        <Route path="/shop/*" element={<ShopRoutes />} />
        <Route path="/admin/*" element={<AdminRoutes />} />
        {UiShowcase && <Route path="/ui-showcase/*" element={<UiShowcase />} />}
        <Route path="*" element={<Navigate to="/shop" replace />} />
      </Routes>
    </Suspense>
  );
}
