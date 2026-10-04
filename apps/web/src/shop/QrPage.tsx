import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { describeError, getQr, type QrInfo } from '../lib/shop-api';
import { useAuth } from './auth';
import { Banner, Skeleton, useToast } from './components';

function download(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

export default function QrPage() {
  const { state } = useAuth();
  const sessionName = state.status === 'authed' ? (state.session.shop?.displayName ?? '') : '';
  const [params, setParams] = useSearchParams();
  const posterMode = params.get('poster') === '1';
  const [info, setInfo] = useState<QrInfo | null>(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { show, node: toast } = useToast();

  useEffect(() => {
    let alive = true;
    setError(null);
    getQr()
      .then(async (q) => {
        const s = await QRCode.toString(q.publicUrl, { type: 'svg', errorCorrectionLevel: 'H', margin: 1 });
        if (alive) { setInfo(q); setSvg(s); }
      })
      .catch((e) => { if (alive) setError(describeError(e)); });
    return () => { alive = false; };
  }, [attempt]);

  async function copy() {
    if (!info) return;
    try { await navigator.clipboard.writeText(info.publicUrl); show('Link copied'); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = info.publicUrl; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); show('Link copied'); } catch { show('Copy failed. Select the link and copy it manually.'); }
      ta.remove();
    }
  }
  async function downloadPng() {
    if (!info) return;
    try {
      const url = await QRCode.toDataURL(info.publicUrl, { errorCorrectionLevel: 'H', width: 1024, margin: 2 });
      download(url, `printout-${info.slug}-qr.png`);
    } catch { show('Could not create the PNG.'); }
  }
  function downloadSvg() {
    if (!info) return;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    download(url, `printout-${info.slug}-qr.svg`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const shopName = sessionName || info?.shopName || '';
  if (error) return <section><h1>Counter QR</h1><Banner onRetry={() => setAttempt((n) => n + 1)}>{error}</Banner></section>;
  if (!info) return <section><h1>Counter QR</h1><Skeleton lines={4} label="Loading QR code" /></section>;

  return (
    <section className={`qr-page${posterMode ? ' poster-mode' : ''}`} aria-labelledby="qr-title">
      <div className="qr-controls">
        <h1 id="qr-title">Counter QR</h1>
        <p className="sh-muted">Customers scan this to open your shop page and send their documents.</p>
        <div className="sh-card qr-card">
          <div className="qr-img" role="img" aria-label={`QR code for ${info.publicUrl}`} dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="qr-url sh-wrap"><a href={info.publicUrl} target="_blank" rel="noopener noreferrer">{info.publicUrl}</a></p>
          <div className="sh-actions">
            <button className="sh-btn" onClick={copy}>Copy link</button>
            <button className="sh-btn" onClick={downloadPng}>Download PNG</button>
            <button className="sh-btn" onClick={downloadSvg}>Download SVG</button>
          </div>
        </div>
        <div className="sh-actions">
          <button className="sh-btn sh-btn-primary" onClick={() => { if (!posterMode) setParams({ poster: '1' }); setTimeout(() => window.print(), 50); }}>Print A4 poster</button>
          {posterMode && <button className="sh-btn" onClick={() => setParams({})}>Back to QR</button>}
        </div>
      </div>

      <div className="qr-poster-wrap" aria-label="Poster preview">
        <div className="qr-poster" data-testid="qr-poster">
          <h2 className="qr-poster-title">SCAN TO PRINT</h2>
          <div className="qr-poster-code" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
          <ol className="qr-poster-steps">
            <li><strong>1.</strong> Upload</li>
            <li><strong>2.</strong> Choose settings</li>
            <li><strong>3.</strong> Send order</li>
          </ol>
          {shopName && <div className="qr-poster-shop">{shopName}</div>}
          <div className="qr-poster-url">{info.publicUrl}</div>
          <p className="qr-poster-note">Documents are automatically deleted 30 minutes after printing.</p>
        </div>
      </div>
      {toast}
    </section>
  );
}
