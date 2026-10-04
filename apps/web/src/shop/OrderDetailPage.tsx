import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatCountdown, formatPaise } from '../lib/format';
import {
  confirmPrinted, describeError, errorCode, getOrder, newRequestId, requestDocumentAccess, transitionOrder,
  type OrderDetail, type OrderStatus, type PrintOptionsSnapshot
} from '../lib/shop-api';
import { ApiError } from '../lib/api';
import { Banner, Modal, Skeleton, StatusChip, useToast } from './components';
import { retentionHyphen, resolveRetentionMinutes } from '../lib/retention';
import { useAuth } from './auth';
import { useAutoRefresh, useDebounced, useTick } from './hooks';
import { useRealtimeRefresh } from './realtime';

const fmtDateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function pageSelectionText(sel: PrintOptionsSnapshot['pageSelection']): string {
  if (!sel || sel.mode === 'all') return 'All pages';
  return `Pages ${sel.ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)).join(', ')}`;
}

type Action = 'accept' | 'start' | 'cancel' | 'ready' | 'collect' | 'open' | 'confirm';

export default function OrderDetailPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<Action | null>(null);
  const [access, setAccess] = useState<{ url: string; expiresAt: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const { show, node: toast } = useToast();
  const gen = useRef(0);

  const load = useCallback(async (initial = false) => {
    const my = ++gen.current;
    try {
      const d = await getOrder(id);
      if (my !== gen.current) return;
      setData(d);
      setNotFound(false);
      if (initial) setError(null);
    } catch (e) {
      if (my !== gen.current) return;
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else if (initial || !(e instanceof ApiError && e.code === 'NETWORK_ERROR')) setError(describeError(e));
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setData(null); setLoading(true); setAccess(null); setPreview(false); setError(null);
    void load(true);
    return () => { gen.current++; };
  }, [load]);

  const refetchSoon = useDebounced(() => void load(), 300);
  useRealtimeRefresh((e) => {
    const evId = e?.data && typeof e.data === 'object' ? (e.data as { id?: unknown; orderId?: unknown }).id ?? (e.data as { orderId?: unknown }).orderId : undefined;
    if (!e || !evId || evId === id) refetchSoon();
  });
  useAutoRefresh(() => void load(), 30_000);

  const doc = data?.document;
  const order = data?.order;
  const deleteAfterMs = doc?.deleteAfter ? Date.parse(doc.deleteAfter) : NaN;
  // Whole seconds remaining until the SERVER's deleteAfter (display only; the server enforces access).
  const secsLeft = useTick(() => (Number.isNaN(deleteAfterMs) ? 0 : Math.ceil((deleteAfterMs - Date.now()) / 1000)));
  const deleted = doc?.status === 'DELETED' || !!doc?.deletedAt;
  const countdownDone = !Number.isNaN(deleteAfterMs) && secsLeft <= 0;
  const docGone = deleted || countdownDone;

  // at zero, refetch (a few times) until the server reports DELETED
  const zeroTries = useRef(0);
  useEffect(() => { zeroTries.current = 0; }, [doc?.deleteAfter]);
  useEffect(() => {
    if (!countdownDone || deleted) return;
    const t = setInterval(() => { if (zeroTries.current++ < 6) void load(); }, 3000);
    void load();
    return () => clearInterval(t);
  }, [countdownDone, deleted, load]);

  const accessLeft = useTick(() => (access ? Math.ceil((Date.parse(access.expiresAt) - Date.now()) / 1000) : 0));
  const accessExpired = !!access && accessLeft <= 0;

  async function handleError(e: unknown) {
    setError(describeError(e));
    const code = errorCode(e);
    const status = e instanceof ApiError ? e.status : 0;
    if (code === 'INVALID_STATUS_TRANSITION' || code === 'DOCUMENT_UNAVAILABLE' || status === 404 || status === 409 || status === 410) await load();
    if (status === 410 || code === 'DOCUMENT_UNAVAILABLE') setAccess(null);
  }

  async function transition(action: Action, to: OrderStatus, okMsg: string) {
    if (acting) return;
    setActing(action); setError(null);
    try {
      await transitionOrder(id, to);
      setCancelOpen(false);
      await load();
      show(okMsg);
    } catch (e) {
      setCancelOpen(false);
      await handleError(e);
    } finally { setActing(null); }
  }

  async function openDocument() {
    if (acting) return;
    setActing('open'); setError(null);
    let w: Window | null = null;
    try { w = typeof window.open === 'function' ? window.open('', '_blank') : null; } catch { w = null; }
    try {
      const r = await requestDocumentAccess(id);
      setAccess({ url: r.url, expiresAt: r.expiresAt });
      if (w) { try { w.opener = null; } catch { /* ignore */ } w.location.href = r.url; }
    } catch (e) {
      try { w?.close(); } catch { /* ignore */ }
      await handleError(e);
    } finally { setActing(null); }
  }

  if (loading) return <div><BackLink /><Skeleton lines={6} label="Loading order" /></div>;
  if (notFound || !data || !order || !doc) {
    return (
      <div>
        <BackLink />
        {error && <Banner onRetry={() => void load(true)}>{error}</Banner>}
        {notFound && <div className="sh-empty"><h2>Order not found</h2><p>It may belong to another shop or no longer exist.</p></div>}
      </div>
    );
  }

  const status = order.status;
  const opts = data.printOptionsSnapshot ?? {};
  const price = data.priceSnapshot ?? {};
  const filename = (order.originalFilename ?? doc.originalFilename ?? null) as string | null;
  const customerRef = order.customerDisplayNameOrReference as string | null | undefined;
  const busy = acting !== null;
  const canPrintDoc = !docGone;

  return (
    <article className="order-detail" aria-labelledby="order-title">
      <BackLink />
      <header className="sh-card od-head">
        <div className="od-head-row">
          <h1 id="order-title">Order #{order.orderNumber}</h1>
          <StatusChip status={status} />
        </div>
        <div className="od-amount tnum">{formatPaise(order.totalPaise)}</div>
        <dl className="sh-dl">
          <div><dt>Placed</dt><dd>{fmtDateTime(order.createdAt)}</dd></div>
          {filename && <div><dt>File</dt><dd className="sh-wrap">{filename}</dd></div>}
          {customerRef && <div><dt>Customer</dt><dd className="sh-wrap">{customerRef}</dd></div>}
        </dl>
      </header>

      {error && <Banner onDismiss={() => setError(null)}>{error}</Banner>}

      {/* ---- status-specific actions: only what the API allows ---- */}
      <section className="sh-card od-actions" aria-label="Actions">
        {status === 'NEW' && (
          <div className="sh-actions">
            <button className="sh-btn sh-btn-primary" disabled={busy} onClick={() => transition('accept', 'ACCEPTED', 'Order accepted')}>{acting === 'accept' ? 'Accepting…' : 'Accept order'}</button>
            <button className="sh-btn sh-btn-danger" disabled={busy} onClick={() => setCancelOpen(true)}>Cancel order</button>
          </div>
        )}
        {status === 'ACCEPTED' && (
          <div className="sh-actions">
            <button className="sh-btn sh-btn-primary" disabled={busy} onClick={() => transition('start', 'PRINTING', 'Marked as printing')}>{acting === 'start' ? 'Starting…' : 'Start printing'}</button>
            <button className="sh-btn sh-btn-danger" disabled={busy} onClick={() => setCancelOpen(true)}>Cancel order</button>
          </div>
        )}
        {status === 'PRINTING' && (
          <>
            <p className="sh-muted">Open the document, print it with your browser's print dialog (Ctrl+P), then confirm once the paper has printed. Opening or printing a document never marks it as printed.</p>
            <div className="sh-actions">
              <button className="sh-btn" disabled={busy || !canPrintDoc} onClick={openDocument}>{acting === 'open' ? 'Opening…' : 'Open document to print'}</button>
              <button className="sh-btn sh-btn-primary sh-btn-lg" disabled={busy || deleted} onClick={() => setConfirmOpen(true)}>Confirm printed successfully</button>
            </div>
          </>
        )}
        {status === 'PRINTED' && (
          <>
            <div className="sh-actions">
              <button className="sh-btn" disabled={busy || docGone} onClick={openDocument}>{acting === 'open' ? 'Opening…' : 'Reprint'}</button>
              <button className="sh-btn sh-btn-primary" disabled={busy} onClick={() => transition('ready', 'READY', 'Marked ready for collection')}>{acting === 'ready' ? 'Saving…' : 'Mark ready'}</button>
            </div>
            <p className="sh-muted">Reprinting does not extend the deletion timer.</p>
          </>
        )}
        {status === 'READY' && (
          <div className="sh-actions">
            <button className="sh-btn sh-btn-primary" disabled={busy} onClick={() => transition('collect', 'COLLECTED', 'Marked as collected')}>{acting === 'collect' ? 'Saving…' : 'Mark collected'}</button>
          </div>
        )}
        {(status === 'COLLECTED' || status === 'CANCELLED' || status === 'EXPIRED') && (
          <p className="sh-muted">This order is {status.toLowerCase()}. No further actions.</p>
        )}
      </section>

      {/* ---- retention / document state ---- */}
      <section className="sh-card" aria-label="Document">
        <h2>Document</h2>
        {deleted ? (
          <div className="sh-banner sh-banner-info" role="status"><strong>Document deleted.</strong>&nbsp;The customer's file has been permanently removed{doc.deletedAt ? ` (${fmtDateTime(doc.deletedAt)})` : ''}. Order details are kept.</div>
        ) : countdownDone ? (
          <div className="sh-banner sh-banner-warn" role="status"><strong>Document deleted.</strong>&nbsp;The retention time has ended; confirming deletion with the server…</div>
        ) : !Number.isNaN(deleteAfterMs) ? (
          <div className="sh-retention" role="timer" aria-live="off">
            <span className="sh-retention-label">File is deleted in</span>
            <span className="sh-retention-time tnum" data-testid="countdown">{formatCountdown(secsLeft * 1000)}</span>
            <span className="sh-muted">at {fmtTime(new Date(deleteAfterMs))}</span>
          </div>
        ) : null}
        {access && canPrintDoc && (
          <div className="od-access">
            {accessExpired ? (
              <p>The secure link has expired. Use the button above to open the document again.</p>
            ) : (
              <>
                <p>
                  Document ready.{' '}
                  <a href={access.url} target="_blank" rel="noopener noreferrer">Open document in a new tab</a>
                  {' '}and use the browser's print dialog (Ctrl+P). The link is short-lived (valid until {fmtTime(new Date(access.expiresAt))}).
                </p>
                <button className="sh-btn sh-btn-sm" onClick={() => setPreview((p) => !p)} aria-expanded={preview}>{preview ? 'Hide preview' : 'Show preview here'}</button>
                {preview && <iframe className="od-preview" title="Document preview" src={access.url} sandbox="allow-same-origin allow-modals" referrerPolicy="no-referrer" />}
              </>
            )}
          </div>
        )}
        <dl className="sh-dl">
          <div><dt>Status</dt><dd>{doc.status}</dd></div>
          {doc.pageCount != null && <div><dt>Pages</dt><dd>{doc.pageCount}</dd></div>}
          <div><dt>Uploaded</dt><dd>{fmtDateTime(doc.uploadedAt)}</dd></div>
          {!doc.printedAt && !deleted && <div><dt>Expires if unprinted</dt><dd>{fmtDateTime(doc.expiresAt)}</dd></div>}
          {doc.printedAt && <div><dt>Printed</dt><dd>{fmtDateTime(doc.printedAt)}</dd></div>}
          {doc.deleteAfter && <div><dt>Scheduled deletion</dt><dd>{fmtDateTime(doc.deleteAfter)}</dd></div>}
          {doc.deletedAt && <div><dt>Deleted</dt><dd>{fmtDateTime(doc.deletedAt)}</dd></div>}
          {doc.deletionState && doc.deletionState !== 'OK' && <div><dt>Deletion state</dt><dd>{doc.deletionState}</dd></div>}
        </dl>
      </section>

      <section className="sh-card" aria-label="Print settings">
        <h2>Print settings</h2>
        <dl className="sh-dl">
          <div><dt>Paper</dt><dd>{opts.paperSize ?? 'A4'}</dd></div>
          {opts.colourMode && <div><dt>Colour</dt><dd>{opts.colourMode === 'colour' ? 'Colour' : 'Black & white'}</dd></div>}
          {opts.sides && <div><dt>Sides</dt><dd>{opts.sides === 'duplex' ? 'Duplex (double-sided)' : 'Single-sided'}</dd></div>}
          {opts.copies != null && <div><dt>Copies</dt><dd>{opts.copies}</dd></div>}
          <div><dt>Pages</dt><dd>{pageSelectionText(opts.pageSelection)}{doc.pageCount != null ? ` of ${doc.pageCount}` : ''}</dd></div>
        </dl>
      </section>

      <section className="sh-card" aria-label="Price breakdown">
        <h2>Price breakdown</h2>
        <dl className="sh-dl">
          {price.selectedPageCount != null && <div><dt>Selected pages</dt><dd className="tnum">{price.selectedPageCount}</dd></div>}
          {price.sheetsPerCopy != null && <div><dt>Sheets per copy</dt><dd className="tnum">{price.sheetsPerCopy}</dd></div>}
          {price.totalSheets != null && <div><dt>Total sheets</dt><dd className="tnum">{price.totalSheets}</dd></div>}
          {price.unitPricePaise != null && <div><dt>Price per sheet</dt><dd className="tnum">{formatPaise(price.unitPricePaise)}</dd></div>}
          <div className="sh-total"><dt>Total</dt><dd className="tnum">{formatPaise(price.totalPaise ?? order.totalPaise)}</dd></div>
        </dl>
        <p className="sh-muted">Customer pays the shop directly. Duplex is charged per physical sheet.</p>
      </section>

      <section className="sh-card" aria-label="History">
        <h2>History</h2>
        <ol className="sh-timeline">
          {data.statusHistory.map((h, i) => (
            <li key={h.id ?? i}>
              <StatusChip status={h.toStatus} />
              <span className="sh-muted">{fmtDateTime(h.createdAt)}</span>
              {h.reason && <span className="sh-wrap"> — {h.reason}</span>}
            </li>
          ))}
        </ol>
      </section>

      {confirmOpen && (
        <ConfirmPrintModal
          onClose={() => setConfirmOpen(false)}
          onConfirm={async (requestId) => {
            setActing('confirm');
            try {
              await confirmPrinted(id, requestId);
              setConfirmOpen(false);
              await load();
              show('Printing confirmed. Deletion countdown started.');
            } catch (e) {
              setConfirmOpen(false);
              await handleError(e);
            } finally { setActing(null); }
          }}
        />
      )}
      {cancelOpen && (
        <Modal title="Cancel this order?" onClose={() => setCancelOpen(false)} busy={acting === 'cancel'}>
          <p>The customer's order #{order.orderNumber} will be cancelled. This cannot be undone.</p>
          <div className="sh-actions">
            <button className="sh-btn" onClick={() => setCancelOpen(false)} disabled={acting === 'cancel'}>Keep order</button>
            <button className="sh-btn sh-btn-danger" disabled={acting === 'cancel'} onClick={() => transition('cancel', 'CANCELLED', 'Order cancelled')}>{acting === 'cancel' ? 'Cancelling…' : 'Cancel order'}</button>
          </div>
        </Modal>
      )}
      {toast}
    </article>
  );
}

function BackLink() {
  return <p><Link className="sh-back" to="/shop">← Back to queue</Link></p>;
}

function ConfirmPrintModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (clientRequestId: string) => Promise<void> }) {
  const { state } = useAuth();
  const retentionMinutes = state.status === 'authed' ? state.session.retentionMinutes : undefined;
  const [requestId] = useState(newRequestId);
  // Display-only estimate; the authoritative deletion time comes from the server after confirmation.
  const [deleteAt] = useState(() => fmtTime(new Date(Date.now() + resolveRetentionMinutes(retentionMinutes) * 60_000)));
  const [submitting, setSubmitting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  async function go() {
    if (submitted.current) return; // double-submit guard
    submitted.current = true;
    setSubmitting(true);
    try { await onConfirm(requestId); } finally { setSubmitting(false); submitted.current = false; }
  }
  return (
    <Modal title="Confirm printed successfully?" onClose={onClose} initialFocusRef={cancelRef} busy={submitting}>
      <p>{`Confirming starts a ${retentionHyphen(retentionMinutes)} countdown. The customer's file will be permanently deleted at ${deleteAt}. Only confirm after the paper has actually printed.`}</p>
      <div className="sh-actions">
        <button ref={cancelRef} className="sh-btn" onClick={onClose} disabled={submitting}>Cancel</button>
        <button className="sh-btn sh-btn-primary" onClick={go} disabled={submitting}>{submitting ? 'Confirming…' : 'Confirm'}</button>
      </div>
    </Modal>
  );
}
