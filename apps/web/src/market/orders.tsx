import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatPaise } from '../lib/format';
import { Banner, Button, Card, Chip, EmptyState, Select, Skeleton, TextArea, TextField, Timeline } from '../ui';
import {
  cancelOrder, completeUpload, createQuote, errorText, markAllRead, markRead, myOrder, myOrders, notifications, PAYMENT_TEXT, placeOrder, putFile, reviewOrder, shopDetail, startUpload, STATUS_TEXT,
  submitUtr, type AppNotification, type CustomerOrder, type Page, type PrintOptions, type Quote, type ShopCard
} from './api';

const ACCEPT = 'application/pdf,image/jpeg,image/png';
const MAX_BYTES = 50 * 1024 * 1024;

/** One idempotency key per order attempt: a retry after a lost response returns the same order instead of a duplicate. */
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);

export function OrderFlowPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [shop, setShop] = useState<ShopCard | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<'file' | 'uploading' | 'options' | 'quoted'>('file');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [colour, setColour] = useState<'bw' | 'colour'>('bw');
  const [sides, setSides] = useState<'single' | 'duplex'>('single');
  const [copies, setCopies] = useState('1');
  const [method, setMethod] = useState<'cash' | 'upi'>('cash');
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  useEffect(() => { shopDetail(id).then(setShop).catch((e) => setError(errorText(e))); }, [id]);

  async function upload(f: File) {
    setError(null);
    if (!ACCEPT.split(',').includes(f.type)) return setError('Choose a PDF, JPG or PNG file.');
    if (f.size === 0) return setError('That file is empty.');
    if (f.size > MAX_BYTES) return setError('That file is too large (50 MB maximum).');
    setFile(f);
    setStep('uploading');
    try {
      const up = await startUpload(id, f);
      await putFile(up, f);
      const done = await completeUpload(up);
      setDocumentId(done.documentId);
      setPages(done.pageCount);
      setStep('options');
    } catch (e) {
      setError(errorText(e));
      setStep('file');
    }
  }

  const copiesNum = Number(copies);
  const copiesOk = Number.isInteger(copiesNum) && copiesNum >= 1 && copiesNum <= 50;
  const options = (): PrintOptions => ({ paperSize: 'A4', colourMode: colour, sides, copies: copiesNum, pageSelection: { mode: 'all' } });

  async function getQuote(e: FormEvent) {
    e.preventDefault();
    if (!documentId || !copiesOk) return;
    setBusy(true);
    setError(null);
    try {
      setQuote(await createQuote(id, documentId, options()));
      setStep('quoted');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      const order = await placeOrder(quote.quoteId, method, note, key.current);
      navigate(`/app/orders/${order.id}`, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const methods = shop?.acceptedPaymentMethods ?? ['cash'];
  return (
    <div className="mk-page">
      <Link to={`/app/shops/${id}`}>&larr; {shop?.shopName ?? 'Shop'}</Link>
      <h1 className="mk-h1">New print order</h1>
      {error && <Banner tone="err">{error}</Banner>}
      <Card>
        <h2 className="mk-h2">1. Your file</h2>
        <label className="mk-drop">
          <span>{file ? file.name : 'Choose a PDF, JPG or PNG (up to 50 MB)'}</span>
          <input type="file" accept={ACCEPT} disabled={step === 'uploading'} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        </label>
        {step === 'uploading' && <p role="status" className="mk-small">Uploading and checking your file&hellip;</p>}
        {pages !== null && step !== 'uploading' && <p className="mk-small" role="status">{pages} page{pages === 1 ? '' : 's'} found. Your file is deleted from our servers soon after printing.</p>}
      </Card>
      {(step === 'options' || step === 'quoted') && (
        <form onSubmit={getQuote} noValidate>
          <Card>
            <h2 className="mk-h2">2. Print options</h2>
            <div className="mk-filters">
              <Select label="Colour" value={colour} onChange={(e) => { setColour(e.target.value as 'bw' | 'colour'); setStep('options'); }}>
                <option value="bw">Black and white</option>
                <option value="colour">Colour</option>
              </Select>
              <Select label="Sides" value={sides} onChange={(e) => { setSides(e.target.value as 'single' | 'duplex'); setStep('options'); }}>
                <option value="single">Single-sided</option>
                <option value="duplex">Double-sided</option>
              </Select>
              <TextField label="Copies" type="number" inputMode="numeric" min={1} max={50} value={copies} error={copiesOk ? null : 'Enter 1 to 50.'} onChange={(e) => { setCopies(e.target.value); setStep('options'); }} />
            </div>
            <p className="mk-small mk-muted">A4 plain paper, all pages.</p>
            <Button type="submit" variant="outline" loading={busy} disabled={!copiesOk}>See price</Button>
          </Card>
        </form>
      )}
      {step === 'quoted' && quote && (
        <Card>
          <h2 className="mk-h2">3. Price and payment</h2>
          <p className="mk-total" aria-live="polite">Total {formatPaise(quote.totalPaise)}</p>
          <p className="mk-small mk-muted">The shop&apos;s current price is applied when you place the order.</p>
          <fieldset className="mk-fieldset">
            <legend>Pay by</legend>
            {methods.map((m) => (
              <label key={m} className="mk-radio"><input type="radio" name="pay" checked={method === m} onChange={() => setMethod(m)} /> {m === 'cash' ? 'Cash at pickup' : 'UPI'}</label>
            ))}
          </fieldset>
          {method === 'upi' && <p className="mk-small mk-muted">After ordering you will pay {shop?.upiId ?? 'the shop'} and enter the UPI reference. The shop confirms the payment.</p>}
          <TextArea label="Note for the shop (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <Button variant="primary" size="lg" fullWidth loading={busy} onClick={submit}>Place order</Button>
        </Card>
      )}
    </div>
  );
}

export function OrdersPage() {
  const [data, setData] = useState<Page<CustomerOrder> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { setError(null); myOrders().then(setData).catch((e) => setError(errorText(e))); }, []);
  useEffect(load, [load]);
  return (
    <div className="mk-page">
      <h1 className="mk-h1">My orders</h1>
      {error && <Banner tone="err" actions={<Button size="sm" onClick={load}>Retry</Button>}>{error}</Banner>}
      {!data && !error && <Skeleton variant="block" height={96} />}
      {data && data.items.length === 0 && <EmptyState title="No orders yet">Find a shop near you to place your first order.</EmptyState>}
      <ul className="mk-list">
        {data?.items.map((o) => (
          <li key={o.id}>
            <Card>
              <div className="mk-row mk-between">
                <h2 className="mk-h2"><Link to={`/app/orders/${o.id}`}>{o.orderNumber}</Link></h2>
                <Chip tone={STATUS_TEXT[o.status].tone}>{STATUS_TEXT[o.status].label}</Chip>
              </div>
              <p className="mk-small mk-muted">{o.shopName} · {formatPaise(o.totalPaise)} · {new Date(o.createdAt).toLocaleDateString()}</p>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OrderPage() {
  const { id = '' } = useParams();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [utr, setUtr] = useState('');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const load = useCallback(() => myOrder(id).then(setOrder).catch((e) => setError(errorText(e))), [id]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 20_000); return () => clearInterval(t); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (!order) return <div className="mk-page">{error ? <Banner tone="err">{error}</Banner> : <Skeleton variant="block" height={160} />}<Link to="/app/orders">My orders</Link></div>;
  const st = STATUS_TEXT[order.status];
  const canCancel = (order.status === 'NEW' || order.status === 'ACCEPTED') && order.payment.status !== 'paid' && order.payment.status !== 'pendingVerification';
  const canReview = ['PRINTING', 'PRINTED', 'READY', 'COLLECTED'].includes(order.status) && !order.isReviewed;
  const needsUtr = order.payment.method === 'upi' && order.payment.status === 'unpaid' && !st.done;
  return (
    <div className="mk-page">
      <Link to="/app/orders">&larr; My orders</Link>
      <div className="mk-row mk-between"><h1 className="mk-h1">{order.orderNumber}</h1><Chip tone={st.tone}>{st.label}</Chip></div>
      {error && <Banner tone="err">{error}</Banner>}
      <Card>
        <p><strong>{order.shopName}</strong></p>
        <p className="mk-small mk-muted">{order.fileName}{order.pages ? ` · ${order.pages} page${order.pages === 1 ? '' : 's'}` : ''} · {order.printOptions?.copies ?? 1} cop{(order.printOptions?.copies ?? 1) === 1 ? 'y' : 'ies'}</p>
        <p className="mk-total">{formatPaise(order.totalPaise)}</p>
        {order.note && <p className="mk-small">Note: {order.note}</p>}
      </Card>
      <Card>
        <h2 className="mk-h2">Payment</h2>
        <p>{order.payment.method === 'upi' ? 'UPI' : 'Cash at pickup'} · {PAYMENT_TEXT[order.payment.status]}</p>
        {needsUtr && (
          <form onSubmit={(e) => { e.preventDefault(); void act(() => submitUtr(order.id, utr)); }} noValidate>
            {order.payment.upiId && <p className="mk-small">Pay <strong>{order.payment.upiId}</strong> using any UPI app, then enter the reference (UTR) from the receipt.</p>}
            <TextField label="UPI reference" value={utr} onChange={(e) => setUtr(e.target.value)} maxLength={22} autoComplete="off" mono />
            <Button type="submit" variant="primary" loading={busy} disabled={utr.trim().length < 8}>Submit reference</Button>
          </form>
        )}
        {order.payment.status === 'pendingVerification' && <p className="mk-small mk-muted">Reference {order.payment.upiTxnRef} sent. The shop will confirm it.</p>}
      </Card>
      {order.statusHistory && (
        <Card>
          <h2 className="mk-h2">Progress</h2>
          <Timeline items={[...order.statusHistory].reverse().map((h) => ({ time: new Date(h.createdAt).toLocaleString(), children: <>{STATUS_TEXT[h.status as keyof typeof STATUS_TEXT]?.label ?? h.status}{h.reason ? ` — ${h.reason}` : ''}</>, tone: h.status === 'REJECTED' ? ('err' as const) : ('default' as const) }))} />
        </Card>
      )}
      {canCancel && <Button variant="danger" loading={busy} onClick={() => void act(() => cancelOrder(order.id))}>Cancel order</Button>}
      {canReview && (
        <Card>
          <h2 className="mk-h2">Rate this shop</h2>
          <div role="radiogroup" aria-label="Rating" className="mk-stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} className={rating >= n ? 'is-on' : ''} onClick={() => setRating(n)}>{'★'}</button>
            ))}
          </div>
          <TextArea label="Comment (optional)" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
          <Button variant="primary" loading={busy} disabled={rating === 0} onClick={() => void act(() => reviewOrder(order.id, rating, comment))}>Submit review</Button>
        </Card>
      )}
      {order.isReviewed && <p className="mk-small mk-muted">Thanks for your review.</p>}
    </div>
  );
}

export function NotificationsPage() {
  const [data, setData] = useState<(Page<AppNotification> & { unreadCount: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { notifications().then(setData).catch((e) => setError(errorText(e))); }, []);
  useEffect(load, [load]);
  return (
    <div className="mk-page">
      <div className="mk-row mk-between">
        <h1 className="mk-h1">Notifications</h1>
        {data && data.unreadCount > 0 && <Button size="sm" onClick={() => void markAllRead().then(load)}>Mark all read</Button>}
      </div>
      {error && <Banner tone="err">{error}</Banner>}
      {!data && !error && <Skeleton variant="block" height={96} />}
      {data && data.items.length === 0 && <EmptyState title="Nothing new">Order and payment updates appear here.</EmptyState>}
      <ul className="mk-list">
        {data?.items.map((n) => (
          <li key={n.id}>
            <Card>
              <p><strong>{n.title}</strong>{!n.readAt && <> <Chip tone="orange" size="sm">New</Chip></>}</p>
              <p className="mk-small">{n.body}</p>
              <p className="mk-small mk-muted">{new Date(n.createdAt).toLocaleString()}</p>
              <div className="mk-row mk-gap">
                {n.orderId && <Link to={`/app/orders/${n.orderId}`}>View order</Link>}
                {!n.readAt && <Button size="sm" variant="ghost" onClick={() => void markRead(n.id).then(load)}>Mark read</Button>}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
