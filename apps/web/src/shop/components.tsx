import { Component, createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type { OrderStatus } from '../lib/shop-api';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  NEW: 'New', ACCEPTED: 'Accepted', PRINTING: 'Print started', PRINTED: 'Printed', READY: 'Ready',
  COLLECTED: 'Collected', CANCELLED: 'Cancelled', EXPIRED: 'Expired'
};

export function StatusChip({ status }: { status: OrderStatus }) {
  return <span className={`sh-chip sh-chip-${status.toLowerCase()}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Banner({ kind = 'error', children, onRetry, onDismiss }: { kind?: 'error' | 'info' | 'warn' | 'ok'; children: ReactNode; onRetry?: () => void; onDismiss?: () => void }) {
  return (
    <div className={`sh-banner sh-banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="sh-banner-text">{children}</span>
      {onRetry && <button className="sh-btn sh-btn-sm" onClick={onRetry}>Retry</button>}
      {onDismiss && <button className="sh-btn sh-btn-sm sh-btn-ghost" onClick={onDismiss} aria-label="Dismiss">Dismiss</button>}
    </div>
  );
}

export function Skeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="sh-skel" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => <div key={i} className="sh-skel-line" style={{ width: `${90 - ((i * 17) % 40)}%` }} />)}
    </div>
  );
}

// ---- toast -------------------------------------------------------------------------------------------
export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  const show = useCallback((m: string) => {
    setMsg(m);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 4000);
  }, []);
  const node = <div className="sh-toast-region" aria-live="polite" role="status">{msg && <div className="sh-toast">{msg}</div>}</div>;
  return { show, node };
}

// ---- modal with focus trap ---------------------------------------------------------------------------
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function Modal({ title, children, onClose, initialFocusRef, busy }: { title: string; children: ReactNode; onClose: () => void; initialFocusRef?: React.RefObject<HTMLElement>; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (initialFocusRef?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => opener?.focus?.();
  }, [initialFocusRef]);
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onClose(); return; }
    if (e.key !== 'Tab') return;
    const els = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!els.length) { e.preventDefault(); return; }
    const first = els[0]!, last = els[els.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  return (
    <div className="sh-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={ref} className="sh-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ---- error boundary ----------------------------------------------------------------------------------
export class ShopErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Shop area crashed', error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="shop-boot" role="alert">
        <h1>Something went wrong</h1>
        <p>The shop screen hit an unexpected problem. Your orders are safe.</p>
        <button className="sh-btn sh-btn-primary" onClick={() => { this.setState({ failed: false }); window.location.assign('/shop'); }}>Reload shop</button>
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
