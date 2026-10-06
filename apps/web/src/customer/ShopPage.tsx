import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { formatPaise } from '../lib/format';
import { retentionPhrase } from '../lib/retention';
import { customerErrorMessage, getShop, submitOrder, type PublicShop } from '../lib/customer-api';
import { getRecentOrders, rememberOrder } from '../lib/customer-storage';
import { ConfigureCard } from './ConfigureCard';
import { UploadCard } from './UploadCard';
import { Alert, NotFound, Skeleton } from './parts';
import { buildOptions, describeOptions, initialConfig, type Config } from './config';
import { newRequestId, useOnline, useQuote, useUpload } from './hooks';

type ShopState = { s: 'loading' } | { s: 'missing' } | { s: 'error'; message: string } | { s: 'ok'; shop: PublicShop };

export function ShopPage() {
  const { id: slug = '' } = useParams();
  const [shop, setShop] = useState<ShopState>({ s: 'loading' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const c = new AbortController();
    setShop({ s: 'loading' });
    getShop(slug, c.signal).then((d) => setShop({ s: 'ok', shop: d })).catch((e) => {
      if ((e as Error).name === 'AbortError') return;
      if (e instanceof ApiError && (e.status === 404 || e.code === 'NOT_FOUND')) setShop({ s: 'missing' });
      else setShop({ s: 'error', message: customerErrorMessage(e).message });
    });
    return () => c.abort();
  }, [slug, reload]);

  if (shop.s === 'loading') return <main className="cx-page" aria-busy="true"><div className="cx-card" role="status" aria-label="Loading shop"><Skeleton lines={3} /></div></main>;
  if (shop.s === 'missing') return <NotFound title="Shop not found" body="We couldn't find this shop. Check the link or scan the shop's QR code again." />;
  if (shop.s === 'error') {
    return <main className="cx-page"><div className="cx-card cx-center"><Alert>{shop.message}</Alert><button className="cx-btn cx-btn-primary" onClick={() => setReload((n) => n + 1)}>Try again</button></div></main>;
  }
  const unavailable = !shop.shop.acceptsOrders || (shop.shop.status !== undefined && shop.shop.status !== 'ACTIVE');
  return <ShopFlow slug={slug} shop={shop.shop} unavailable={unavailable} />;
}

function ShopFlow({ slug, shop, unavailable }: { slug: string; shop: PublicShop; unavailable: boolean }) {
  const navigate = useNavigate();
  const online = useOnline();
  const upload = useUpload(slug);
  const [cfg, setCfg] = useState<Config>(initialConfig);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ code: string; message: string } | null>(null);
  const lock = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const recent = useMemo(() => getRecentOrders(), []);

  const doc = upload.state.phase === 'ready' ? upload.state.doc : null;
  const pageCount = doc?.pageCount ?? null;
  const built = useMemo(() => buildOptions(cfg, pageCount), [cfg, pageCount]);
  const { state: quote, refresh } = useQuote(slug, doc?.documentId ?? null, built.options);

  // A new file resets the page selection (old ranges may not fit the new document).
  const docId = doc?.documentId;
  useEffect(() => { setCfg((c) => ({ ...c, pageMode: 'all', pageText: '' })); setSubmitError(null); }, [docId]);

  const patch = useCallback((p: Partial<Config>) => { setCfg((c) => ({ ...c, ...p })); setSubmitError(null); }, []);

  const serverPageError = quote.status === 'error' && quote.code === 'INVALID_PAGE_RANGE' ? quote.message : null;

  const submit = async () => {
    if (lock.current || quote.status !== 'ready') return;
    lock.current = true; setSubmitting(true); setSubmitError(null);
    const display = name.trim() || undefined;
    const key = `${quote.quote.quoteId}|${display ?? ''}`;
    if (attempt.current?.key !== key) attempt.current = { key, id: newRequestId() };
    try {
      const r = await submitOrder(slug, { quoteId: quote.quote.quoteId, ...(display ? { customerDisplayNameOrReference: display } : {}), clientRequestId: attempt.current.id });
      rememberOrder({ token: r.trackingToken, orderNumber: r.orderNumber, shopName: shop.displayName, slug });
      navigate(`/t/${encodeURIComponent(r.trackingToken)}`, { replace: true }); // lock stays held: no second submit is possible
    } catch (e) {
      const m = customerErrorMessage(e, 'order');
      if (m.code === 'QUOTE_EXPIRED' || m.code === 'INVALID_QUOTE') { attempt.current = null; refresh(); }
      setSubmitError(m);
      lock.current = false; setSubmitting(false);
    }
  };

  if (unavailable) {
    return (
      <main className="cx-page"><Header shop={shop} />
        <div className="cx-card"><h2 className="cx-h2">Not accepting orders</h2>
          <p className="cx-muted">{shop.displayName} isn&apos;t taking online orders right now. Please check with the shop or try again later.</p></div>
      </main>
    );
  }

  const canSubmit = quote.status === 'ready' && !submitting && online && !!doc;
  const fileName = upload.state.phase === 'ready' ? upload.state.file.name : '';
  return (
    <main className="cx-page">
      <Header shop={shop} />
      {recent.length > 0 && upload.state.phase === 'idle' && (
        <nav className="cx-card cx-recent" aria-label="My recent orders">
          <h2 className="cx-h2">My recent orders</h2>
          <ul>{recent.map((o) => <li key={o.token}><Link to={`/t/${encodeURIComponent(o.token)}`} className="cx-link">{o.orderNumber}{o.shopName ? ` · ${o.shopName}` : ''}</Link></li>)}</ul>
        </nav>
      )}
      <div className="cx-grid">
        <div className="cx-col">
          <UploadCard state={upload.state} limits={upload.limits} onFile={(f) => void upload.start(f)} onCancel={upload.cancel} onRetry={upload.retry} onReplace={upload.reset} />
          {doc && <ConfigureCard cfg={cfg} onChange={patch} pageCount={pageCount} copiesError={built.copiesError} pagesError={built.pagesError} serverPageError={serverPageError} />}
        </div>
        <aside className="cx-col cx-aside">
          <section className="cx-card cx-summary" aria-labelledby="cx-review-h">
            <h2 className="cx-h2" id="cx-review-h">{doc ? '3. Review & submit' : 'Your order'}</h2>
            {!doc && <p className="cx-muted">Choose a file to see your price.</p>}
            {doc && (
              <>
                <p className="cx-file-name" title={fileName}>{fileName}</p>
                {built.options && <p className="cx-muted">{describeOptions(built.options).join(' · ')}</p>}
                <QuoteView quote={quote} valid={!!built.options} />
                <div className="cx-field">
                  <label className="cx-label" htmlFor="cx-name">Name or reference <span className="cx-muted">(optional)</span></label>
                  <input id="cx-name" className="cx-input" maxLength={100} autoComplete="off" value={name} placeholder="So the shop can find your order" onChange={(e) => setName(e.target.value)} />
                </div>
                {submitError && <Alert>{submitError.message}</Alert>}
                <button type="button" className="cx-btn cx-btn-primary cx-btn-lg cx-block" disabled={!canSubmit} onClick={() => void submit()}>
                  {submitting ? 'Placing order…' : 'Place order'}
                </button>
                {!online && <p className="cx-muted cx-small">Reconnect to place your order.</p>}
                <p className="cx-small"><strong>Pay the shop directly when you collect.</strong> No online payment.</p>
              </>
            )}
            <p className="cx-small cx-muted">Your file is deleted {retentionPhrase(shop.retentionMinutes)} after the shop starts printing. Unprinted files are removed within 24 hours.</p>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Header({ shop }: { shop: PublicShop }) {
  return (
    <header className="cx-header">
      <h1 className="cx-h1">{shop.displayName}</h1>
      {shop.address && <p className="cx-muted cx-addr">{shop.address}</p>}
      <p className="cx-privacy">Deleted {retentionPhrase(shop.retentionMinutes)} after the shop starts printing.</p>
    </header>
  );
}

function QuoteView({ quote, valid }: { quote: ReturnType<typeof useQuote>['state']; valid: boolean }) {
  if (!valid) return <p className="cx-muted" role="status">Fix the highlighted option to see your price.</p>;
  if (quote.status === 'idle' || quote.status === 'loading') {
    return <div className="cx-quote" role="status" aria-label="Calculating price" aria-busy="true"><Skeleton lines={2} /></div>;
  }
  if (quote.status === 'error') return <Alert>{quote.message}</Alert>;
  const q = quote.quote;
  return (
    <div className="cx-quote" aria-live="polite">
      <div className="cx-total"><span>Estimated total</span><strong className="cx-tnum" data-testid="total">{formatPaise(q.totalPaise)}</strong></div>
      <dl className="cx-breakdown cx-tnum">
        <div><dt>Pages selected</dt><dd>{q.selectedPageCount}</dd></div>
        <div><dt>Sheets per copy</dt><dd>{q.sheetsPerCopy}</dd></div>
        <div><dt>Total sheets</dt><dd>{q.totalSheets}</dd></div>
        <div><dt>Price per sheet</dt><dd>{formatPaise(q.unitPricePaise)}</dd></div>
      </dl>
    </div>
  );
}
