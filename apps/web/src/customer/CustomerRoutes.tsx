import { Route, Routes, useLocation } from 'react-router-dom';
import { BrandLogo } from '../ui';
import './customer.css';
import { CustomerErrorBoundary } from './ErrorBoundary';
import { ShopPage } from './ShopPage';
import { TrackingPage } from './TrackingPage';
import { NotFound } from './parts';
import { useOnline } from './hooks';

// App mounts this at both `/p/*` and `/t/*`; nested <Routes> match relative to that splat.
export default function CustomerRoutes() {
  const tracking = useLocation().pathname.startsWith('/t/');
  const online = useOnline();
  return (
    <div className="pb-theme cx-root">
      <CustomerErrorBoundary>
        {!online && <div className="cx-offline" role="status">You&apos;re offline — uploading and ordering need a connection.</div>}
        <header className="cx-brandbar"><BrandLogo /></header>
        <Routes>
          <Route path=":id" element={tracking ? <TrackingPage /> : <ShopPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </CustomerErrorBoundary>
    </div>
  );
}
