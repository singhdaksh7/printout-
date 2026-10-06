import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatCountdown, formatPaise } from '../lib/format';
import {
  describeError, errorCode, getOrder, newRequestId, transitionOrder,
  type OrderDetail, type OrderStatus
} from '../lib/shop-api';
import { ApiError } from '../lib/api';
import { Banner, Modal, pageSelectionText, Skeleton, StatusChip, useToast } from './components';
import { retentionHyphen } from '../lib/retention';
import { useAuth } from './auth';
import { printNowAndOpen, saveFileToDevice, SAVE_FILE_NOTE } from './print-actions';
import { useAutoRefresh, useDebounced, useTick } from './hooks';
import { useRealtimeRefresh } from './realtime';

const fmtDateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Display-only: minutes between the server's printInitiatedAt and deleteAfter (falls back to the configured policy). */
function resolveMins(deleteAfter?: string | null, started?: string | null, policy?: number): number {
  const m = deleteAfter && started ? Math.round((Date.parse(deleteAfter) - Date.parse(started)) / 60_000) : NaN;
  return Number.isFinite(m) && m > 0 ? m : (policy && policy > 0 ? policy : 30);
}

type Action = 'cancel' | 'printnow' | 'save';

export default function OrderDetailPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<Action | null>(null);
  const [access, setAccess] = useState<{ url: string; expiresAt: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const { show, node: toast } = useToast();
  const { state } = useAuth();
  const retentionMinutes = state.status === 'authed' ? state.session.retentionMinutes : undefined;
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

  async function transition(action: Action, to: 'CANCELLED', okMsg: string) {
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

  /** Print / Reprint: the first success starts the server-side retention window; later calls only reopen the viewer. */
  async function printNowAction() {
    if (acting) return;
    setActing('printnow'); setError(null);
    try {
      const r = await printNowAndOpen(id);
      setAccess({ url: r.access.url, expiresAt: r.access.expiresAt });
      await load();
      show(r.firstPrint ? `Print started. Available for reprint for ${resolveMins(r.document?.deleteAfter, r.document?.printInitiatedAt, retentionMinutes)} minutes.` : 'Document opened again');
    } catch (e) { await handleError(e); } finally { setActing(null); }
  }

  /** Save file: an explicit download of the original document; changes no state and no retention timer. */
  async function saveFileAction() {
    if (acting) return;
    setActing('save'); setError(null);
    try { await saveFileToDevice(id); show('Download started'); } catch (e) { await handleError(e); } finally { setActing(null); }
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
  const initiated = !!(doc.printInitiatedAt ?? doc.printedAt);
  const printable = !docGone && status !== 'CANCELLED' && status !== 'EXPIRED';

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

      {/* ---- one primary action: Print (first time) / Reprint (while the file is retained). No lifecycle steps to manage. ---- */}
      <section className="sh-card od-actions" aria-label="Actions">
        {printable ? (
          <>
            <div className="sh-actions">
              <button className="sh-btn sh-btn-primary sh-btn-lg" disabled={busy} onClick={printNowAction}>{acting === 'printnow' ? 'Opening…' : initiated ? 'Reprint' : 'Print'}</button>
              <button className="sh-btn" disabled={busy} onClick={saveFileAction}>{acting === 'save' ? 'Saving…' : 'Save file'}</button>
              {!initiated && status === 'NEW' && (
                <button className="sh-btn sh-btn-sm sh-btn-danger" disabled={busy} onClick={() => setCancelOpen(true)}>Cancel order</button>
              )}
            </div>
            <p className="sh-muted">
              {initiated
                ? 'Reprinting or saving does not extend the deletion timer. '
                : `Print opens the document in a secure viewer and starts a ${retentionHyphen(retentionMinutes)} countdown, after which the file is deleted. `}
              {SAVE_FILE_NOTE}
            </p>
          </>
        ) : status === 'CANCELLED' || status === 'EXPIRED' ? (
          <p className="sh-muted">This order is {status.toLowerCase()}. No further actions.</p>
        ) : (
          <p className="sh-muted">The file has been deleted, so it can no longer be printed or saved. Order details are kept.</p>
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
        {access && printable && (
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
          {!initiated && !deleted && <div><dt>Expires if not printed</dt><dd>{fmtDateTime(doc.expiresAt)}</dd></div>}
          {initiated && <div><dt>Print started</dt><dd>{fmtDateTime(doc.printInitiatedAt ?? doc.printedAt)}</dd></div>}
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
