import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeError, getQr, getSettings, type QrInfo, type ShopSettings } from '../../lib/shop-api';
import { Banner, Button, Card, Checkbox, EmptyState, RadioGroup, SegmentedControl, Skeleton, TextField, useToast } from '../../ui';
import { useAuth } from '../auth';
import { getMeasure } from './fonts';
import { buildPoster, type Poster } from './layout';
import { DEFAULT_HEADLINE, DEFAULT_SETTINGS, HEADLINE_MAX, PAPER_SIZES, TEMPLATES, TEMPLATE_INFO, clearSettings, loadSettings, posterFilename, saveSettings, validatePublicUrl, type PaperSize, type PosterSettings, type TemplateId } from './model';
import { PosterPreview } from './PosterPreview';
import { renderPdf } from './pdf';
import { renderPng } from './png';
import './poster.css';

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

interface Loaded { qr: QrInfo; url: string; shop: ShopSettings | null }

export default function PosterPage() {
  const { state } = useAuth();
  const sessionName = state.status === 'authed' ? (state.session.shop?.displayName ?? '') : '';
  const retentionMinutes = state.status === 'authed' ? state.session.retentionMinutes : undefined;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [settings, setSettings] = useState<PosterSettings>(DEFAULT_SETTINGS);
  const [poster, setPoster] = useState<Poster | null>(null);
  const [busy, setBusy] = useState<'pdf' | 'png' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const { show, node: toast } = useToast();
  const templateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setError(null); setData(null);
    Promise.all([getQr(), getSettings().catch(() => null)])
      .then(([qr, shop]) => {
        if (!alive) return;
        const url = validatePublicUrl(qr.publicUrl, qr.slug);
        if (!url) { setError('We could not confirm your shop link, so no poster can be made yet. Please try again or contact support.'); return; }
        setSettings(loadSettings(qr.slug));
        setData({ qr, url, shop });
      })
      .catch((e) => { if (alive) setError(describeError(e)); });
    return () => { alive = false; };
  }, [attempt]);

  const shopName = sessionName || data?.qr.shopName || data?.shop?.displayName || '';
  const address = data?.shop?.address?.trim() || '';
  const contact = data?.shop?.publicContact?.trim() || '';

  const update = useCallback((patch: Partial<PosterSettings>) => setSettings((s) => ({ ...s, ...patch })), []);
  useEffect(() => { if (data) saveSettings(data.qr.slug, settings); }, [data, settings]);

  // Rebuild the layout whenever an input changes. Fonts load once; the layout itself is synchronous.
  useEffect(() => {
    if (!data) return;
    let alive = true;
    getMeasure()
      .then((m) => {
        if (!alive) return;
        setPoster(buildPoster({ shopName, slug: data.qr.slug, publicUrl: data.url, address, contact, retentionMinutes, settings }, m));
      })
      .catch(() => { if (alive) setError('The poster could not be prepared in this browser. Please try again.'); });
    return () => { alive = false; };
  }, [data, shopName, address, contact, retentionMinutes, settings]);

  const label = useMemo(() => (data ? `${TEMPLATE_INFO[settings.template].label} poster preview for ${shopName || 'your shop'}, ${settings.size}. The QR code opens ${data.url}` : ''), [data, settings, shopName]);

  async function exportAs(kind: 'pdf' | 'png') {
    if (!poster || !data || busy) return;
    setBusy(kind); setExportError(null);
    try {
      if (kind === 'pdf') {
        const bytes = await renderPdf(poster, { title: `${shopName || 'Shop'} - Scan to upload documents` });
        save(new Blob([bytes as BlobPart], { type: 'application/pdf' }), posterFilename(data.qr.slug, settings.size, 'pdf'));
      } else {
        save(await renderPng(poster), posterFilename(data.qr.slug, settings.size, 'png'));
      }
      show(kind === 'pdf' ? 'Poster PDF downloaded' : 'Poster PNG downloaded');
    } catch {
      setExportError(`The ${kind.toUpperCase()} could not be created. Please try again.`);
    } finally { setBusy(null); }
  }

  function reset() {
    if (!data) return;
    clearSettings(data.qr.slug);
    setSettings({ ...DEFAULT_SETTINGS });
    show('Poster reset to the default template');
    templateRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }

  if (error) {
    return (
      <section className="pb-theme pb-page" aria-labelledby="poster-title">
        <h1 id="poster-title" className="pb-h1">Poster generator</h1>
        <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>{error}</Banner>
      </section>
    );
  }
  if (!data || !poster) {
    return <section className="pb-theme pb-page" aria-labelledby="poster-title"><h1 id="poster-title" className="pb-h1">Poster generator</h1><Skeleton lines={6} label="Loading poster generator" /></section>;
  }

  return (
    <section className="pb-theme pb-page pb-poster-page" aria-labelledby="poster-title">
      <div className="pb-pagehead">
        <div>
          <h1 id="poster-title" className="pb-h1">Poster generator</h1>
          <p className="pb-muted pb-pagehead__sub">Make a print-ready poster that sends customers straight to your upload page.</p>
        </div>
        <Link className="pb-btn pb-btn--outline pb-btn--sm" to="/shop/qr">Back to QR &amp; standee</Link>
      </div>

      <div className="pb-poster-layout">
        <div className="pb-poster-controls">
          <Card>
            <div ref={templateRef}>
              <RadioGroup<TemplateId>
                legend="Template"
                variant="card"
                value={settings.template}
                onChange={(template) => update({ template })}
                options={TEMPLATES.map((t) => ({ value: t, label: TEMPLATE_INFO[t].label, description: TEMPLATE_INFO[t].description }))}
              />
            </div>
          </Card>
          <Card className="pb-poster-fields">
            <SegmentedControl<PaperSize> label="Paper size" value={settings.size} onChange={(size) => update({ size })} options={PAPER_SIZES.map((s) => ({ value: s, label: s }))} />
            <TextField
              label="Call to action"
              value={settings.headline}
              maxLength={HEADLINE_MAX}
              onChange={(e) => update({ headline: e.target.value })}
              onBlur={() => { if (!settings.headline.trim()) update({ headline: DEFAULT_HEADLINE }); }}
              helperText={`Up to ${HEADLINE_MAX} characters. Leave empty to use "${DEFAULT_HEADLINE}".`}
            />
            <fieldset className="pb-poster-checks">
              <legend className="pb-field__label">Show on the poster</legend>
              <Checkbox label="Link under the QR code" checked={settings.showUrl} onChange={(e) => update({ showUrl: e.target.checked })} />
              <Checkbox
                label="Shop address"
                checked={settings.showAddress && !!address}
                disabled={!address}
                onChange={(e) => update({ showAddress: e.target.checked })}
                hint={address ? undefined : <>No address saved yet. <Link to="/shop/settings">Add it in Settings</Link>.</>}
              />
              <Checkbox
                label="Contact details"
                checked={settings.showContact && !!contact}
                disabled={!contact}
                onChange={(e) => update({ showContact: e.target.checked })}
                hint={contact ? undefined : <>No public contact saved yet. <Link to="/shop/settings">Add it in Settings</Link>.</>}
              />
              <Checkbox label="Document deletion note" checked={settings.showPrivacy} onChange={(e) => update({ showPrivacy: e.target.checked })} />
            </fieldset>
            {poster.replaced > 0 && (
              <Banner tone="warn">{poster.replaced === 1 ? 'One character' : `${poster.replaced} characters`} in your text cannot be printed on the poster and {poster.replaced === 1 ? 'is' : 'are'} shown as "?". The poster supports Latin letters, digits and common punctuation.</Banner>
            )}
          </Card>
          <div className="pb-poster-actions">
            <Button variant="primary" onClick={() => exportAs('pdf')} disabled={!!busy} loading={busy === 'pdf'} iconStart="download">Download PDF</Button>
            <Button variant="outline" onClick={() => exportAs('png')} disabled={!!busy} loading={busy === 'png'}>Download PNG</Button>
            <Button variant="ghost" onClick={reset}>Reset to default</Button>
          </div>
          {exportError && <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => setExportError(null)}>Dismiss</Button>}>{exportError}</Banner>}
          <Card>
            <h2 className="pb-h3">How to print</h2>
            <ol className="pb-poster-steps">
              <li>Open the PDF and choose <strong>{settings.size}</strong> paper.</li>
              <li>Set scale to <strong>100% / Actual size</strong>. Do not use &quot;Fit to page&quot;.</li>
              <li>Pick the highest quality your printer offers. Colour looks best; black and white still scans.</li>
              <li>Before displaying it, scan the printed poster with your own phone.</li>
            </ol>
          </Card>
        </div>

        <div className="pb-poster-stage" aria-label="Poster preview">
          <div className="pb-poster-paper" style={{ aspectRatio: `${poster.width} / ${poster.height}` }}>
            <PosterPreview poster={poster} label={label} />
          </div>
          <p className="pb-muted pb-poster-caption">{settings.size} portrait. Scans to <span className="pb-mono pb-wrap">{data.url}</span></p>
        </div>
      </div>
      {toast}
    </section>
  );
}
