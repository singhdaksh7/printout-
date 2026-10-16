import { Component, createContext, useContext, useEffect, type ErrorInfo, type ReactNode } from 'react';
import type { OrderStatus } from '../lib/shop-api';
import { Button } from '../ui';

/** The shop's wording for each order status. `OrderStatusChip` (ui/domain) must keep saying the same words (a test pins them). */
export const STATUS_LABEL: Record<OrderStatus, string> = {
  NEW: 'New', ACCEPTED: 'Accepted', PRINTING: 'Print started', PRINTED: 'Print confirmed (legacy)', READY: 'Ready (legacy)',
  COLLECTED: 'Collected (legacy)', CANCELLED: 'Cancelled', EXPIRED: 'Expired'
};

// ---- error boundary ----------------------------------------------------------------------------------
export class ShopErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Shop area crashed', error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="shop-boot pb-theme" role="alert">
        <h1 className="pb-h1">Something went wrong</h1>
        <p>The shop screen hit an unexpected problem. Your orders are safe.</p>
        <Button variant="primary" onClick={() => { this.setState({ failed: false }); window.location.assign('/shop'); }}>Reload shop</Button>
      </div>
    );
  }
}

// ---- unsaved-changes registry (nav links in the shell consult this) -----------------------------------
interface UnsavedApi { setDirty(key: string, dirty: boolean): void; isDirty(): boolean }
export const UnsavedContext = createContext<UnsavedApi>({ setDirty: () => {}, isDirty: () => false });
export function useUnsavedGuard(dirty: boolean, key = 'page') {
  const { setDirty } = useContext(UnsavedContext);
  useEffect(() => {
    setDirty(key, dirty);
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, key, setDirty]);
  useEffect(() => () => setDirty(key, false), [key, setDirty]);
}
export const UNSAVED_PROMPT = 'You have unsaved changes. Leave without saving?';

/** "All pages" / "Pages 1–3, 5" for the shop's print-settings display. */
export function pageSelectionText(sel: { mode: 'all' } | { mode: 'ranges'; ranges: { from: number; to: number }[] } | null | undefined): string {
  if (!sel || sel.mode === 'all') return 'All pages';
  return `Pages ${sel.ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)).join(', ')}`;
}
