import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatCountdown, formatPaise } from '../lib/format';
import {
  describeError, errorCode, getOrder, newRequestId, transitionOrder,
  type OrderDetail, type OrderStatus
} from '../lib/shop-api';
import { ApiError } from '../lib/api';
import { Banner, Button, Card, CardHeader, EmptyState, Icon, KeyValueList, Modal, OrderStatusChip, Skeleton, Timeline, buttonClass, useToast, type KeyValueItem } from '../ui';
import { pageSelectionText } from './components';
import { retentionHyphen } from '../lib/retention';
import { useAuth } from './auth';
import { printNowAndOpen, saveFileToDevice, SAVE_FILE_NOTE } from './print-actions';
import { useAutoRefresh, useDebounced, useTick } from './hooks';
import { useRealtimeRefresh } from './realtime';
import './pb-pages.css';

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

  if (loading) return <div className="pb-theme pb-page pb-od"><BackLink /><Skeleton lines={6} label="Loading order" /></div>;
  if (notFound || !data || !order || !doc) {
    return (
      <div className="pb-theme pb-page pb-od">
        <BackLink />
        {error && <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => void load(true)}>Retry</Button>}>{error}</Banner>}
        {notFound && (
          <Card padding="none">
            <EmptyState icon="file-text" titleAs="h2" title="Order not found">It may belong to another shop or no longer exist.</EmptyState>
          </Card>
        )}
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

  const docFacts: KeyValueItem[] = [
    { label: 'Status', value: doc.status },
    ...(doc.pageCount != null ? [{ label: 'Pages', value: doc.pageCount }] : []),
    { label: 'Uploaded', value: fmtDateTime(doc.uploadedAt) },
    ...(!initiated && !deleted ? [{ label: 'Expires if not printed', value: fmtDateTime(doc.expiresAt) }] : []),
    ...(initiated ? [{ label: 'Print started', value: fmtDateTime(doc.printInitiatedAt ?? doc.printedAt) }] : []),
    ...(doc.deleteAfter ? [{ label: 'Scheduled deletion', value: fmtDateTime(doc.deleteAfter) }] : []),
    ...(doc.deletedAt ? [{ label: 'Deleted', value: fmtDateTime(doc.deletedAt) }] : []),
    ...(doc.deletionState && doc.deletionState !== 'OK' ? [{ label: 'Deletion state', value: doc.deletionState }] : [])
  ];
  const settingFacts: KeyValueItem[] = [
    { label: 'Paper', value: opts.paperSize ?? 'A4' },
    ...(opts.colourMode ? [{ label: 'Colour', value: opts.colourMode === 'colour' ? 'Colour' : 'Black & white' }] : []),
    ...(opts.sides ? [{ label: 'Sides', value: opts.sides === 'duplex' ? 'Duplex (double-sided)' : 'Single-sided' }] : []),
    ...(opts.copies != null ? [{ label: 'Copies', value: opts.copies }] : []),
    { label: 'Pages', value: `${pageSelectionText(opts.pageSelection)}${doc.pageCount != null ? ` of ${doc.pageCount}` : ''}` }
  ];
  const priceFacts: KeyValueItem[] = [
    ...(price.selectedPageCount != null ? [{ label: 'Selected pages', value: price.selectedPageCount }] : []),
    ...(price.sheetsPerCopy != null ? [{ label: 'Sheets per copy', value: price.sheetsPerCopy }] : []),
    ...(price.totalSheets != null ? [{ label: 'Total sheets', value: price.totalSheets }] : []),
    ...(price.unitPricePaise != null ? [{ label: 'Price per sheet', value: formatPaise(price.unitPricePaise) }] : []),
    { label: 'Total', value: formatPaise(price.totalPaise ?? order.totalPaise), strong: true }
  ];

  return (
    <article className="pb-theme pb-page pb-od" aria-labelledby="order-title">
      <BackLink />
      <Card as="header" className="pb-od-head">
        <div className="pb-od-head__row">
          <h1 id="order-title" className="pb-h1">Order #{order.orderNumber}</h1>
          <OrderStatusChip status={status} />
        </div>
        <p className="pb-od-amount">{formatPaise(order.totalPaise)}</p>
        <KeyValueList items={[
          { label: 'Placed', value: fmtDateTime(order.createdAt) },
          ...(filename ? [{ label: 'File', value: filename }] : []),
          ...(customerRef ? [{ label: 'Customer', value: customerRef }] : [])
        ]} />
      </Card>

      {error && <Banner tone="err" onDismiss={() => setError(null)}>{error}</Banner>}

      {/* ---- one primary action: Print (first time) / Reprint (while the file is retained). No lifecycle steps to manage. ---- */}
      <Card as="section" aria-label="Actions">
        {printable ? (
          <>
            <div className="pb-od-actions__row">
              <Button variant="primary" size="lg" loading={acting === 'printnow'} disabled={busy} onClick={printNowAction}>{acting === 'printnow' ? 'Opening…' : initiated ? 'Reprint' : 'Print'}</Button>
              <Button variant="outline" size="lg" loading={acting === 'save'} disabled={busy} onClick={saveFileAction}>{acting === 'save' ? 'Saving…' : 'Save file'}</Button>
              {!initiated && status === 'NEW' && (
                <Button variant="outline" size="lg" disabled={busy} onClick={() => setCancelOpen(true)}>Cancel order</Button>
              )}
            </div>
            <p className="pb-muted pb-od-note">
              {initiated
                ? 'Reprinting or saving does not extend the deletion timer. '
                : `Print opens the document in a secure viewer and starts a ${retentionHyphen(retentionMinutes)} countdown, after which the file is deleted. `}
              {SAVE_FILE_NOTE}
            </p>
          </>
        ) : status === 'CANCELLED' || status === 'EXPIRED' ? (
          <p className="pb-muted">This order is {status.toLowerCase()}. No further actions.</p>
        ) : (
          <p className="pb-muted">The file has been deleted, so it can no longer be printed or saved. Order details are kept.</p>
        )}
      </Card>

      {/* ---- retention / document state ---- */}
      <Card as="section" aria-label="Document">
        <CardHeader title="Document" />
        {deleted ? (
          <Banner tone="info" title="Document deleted.">The customer's file has been permanently removed{doc.deletedAt ? ` (${fmtDateTime(doc.deletedAt)})` : ''}. Order details are kept.</Banner>
        ) : countdownDone ? (
          <Banner tone="warn" title="Document deleted.">The retention time has ended; confirming deletion with the server…</Banner>
        ) : !Number.isNaN(deleteAfterMs) ? (
          <div className="pb-countdown" role="timer" aria-live="off">
            <span className="pb-countdown__label">File is deleted in</span>
            <span className="pb-countdown__time" data-testid="countdown">{formatCountdown(secsLeft * 1000)}</span>
            <span>at {fmtTime(new Date(deleteAfterMs))}</span>
          </div>
        ) : null}
        {access && printable && (
          <div className="pb-od-access">
            {accessExpired ? (
              <Banner tone="warn" icon={false}>The secure link has expired. Use the button above to open the document again.</Banner>
            ) : (
              <>
                <Banner
                  tone="info"
                  icon="file-text"
                  actions={<Button size="sm" variant="outline" onClick={() => setPreview((p) => !p)} aria-expanded={preview}>{preview ? 'Hide preview' : 'Show preview here'}</Button>}
                >
                  Document ready.{' '}
                  <a href={access.url} target="_blank" rel="noopener noreferrer">Open document in a new tab</a>
                  {' '}and use the browser's print dialog (Ctrl+P). The link is short-lived (valid until {fmtTime(new Date(access.expiresAt))}).
                </Banner>
                {preview && <iframe className="pb-od-preview" title="Document preview" src={access.url} sandbox="allow-same-origin allow-modals" referrerPolicy="no-referrer" />}
              </>
            )}
          </div>
        )}
        <KeyValueList items={docFacts} />
      </Card>

      <Card as="section" aria-label="Print settings">
        <CardHeader title="Print settings" />
        <KeyValueList items={settingFacts} />
      </Card>

      <Card as="section" aria-label="Price breakdown">
        <CardHeader title="Price breakdown" />
        <KeyValueList items={priceFacts} />
        <p className="pb-muted pb-od-note">Customer pays the shop directly. Duplex is charged per physical sheet.</p>
      </Card>

      <Card as="section" aria-label="History">
        <CardHeader title="History" />
        <Timeline items={data.statusHistory.map((h) => ({
          time: fmtDateTime(h.createdAt),
          children: <><OrderStatusChip status={h.toStatus} size="sm" />{h.reason && <span className="pb-wrap"> — {h.reason}</span>}</>
        }))} />
      </Card>

      {cancelOpen && (
        <Modal
          title="Cancel this order?"
          tone="danger"
          onClose={() => setCancelOpen(false)}
          busy={acting === 'cancel'}
          footer={
            <>
              <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={acting === 'cancel'}>Keep order</Button>
              <Button variant="danger" loading={acting === 'cancel'} disabled={acting === 'cancel'} onClick={() => transition('cancel', 'CANCELLED', 'Order cancelled')}>{acting === 'cancel' ? 'Cancelling…' : 'Cancel order'}</Button>
            </>
          }
        >
          <p>The customer's order #{order.orderNumber} will be cancelled. This cannot be undone.</p>
        </Modal>
      )}
      {toast}
    </article>
  );
}

function BackLink() {
  return (
    <p className="pb-back">
      <Link className={buttonClass({ variant: 'ghost', size: 'sm' })} to="/shop"><Icon name="arrow-left" size={18} /> Back to queue</Link>
    </p>
  );
}
