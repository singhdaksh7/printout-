import { useRef, useState, type DragEvent } from 'react';
import { formatBytes } from '../lib/format';
import type { UploadLimits } from '../lib/customer-api';
import type { UploadState } from './hooks';
import { Alert } from './parts';

type Props = { state: UploadState; limits: UploadLimits; onFile: (f: File) => void; onCancel: () => void; onRetry: () => void; onReplace: () => void };

export function UploadCard({ state, limits, onFile, onCancel, onRetry, onReplace }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const busy = state.phase === 'validating' || state.phase === 'uploading' || state.phase === 'verifying';
  const pick = () => input.current?.click();
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !busy) onFile(f);
  };
  const pct = state.phase === 'uploading' ? Math.round(state.progress * 100) : state.phase === 'verifying' ? 100 : 0;
  const file = state.phase === 'idle' ? null : state.file;

  return (
    <section className="cx-card" aria-labelledby="cx-upload-h">
      <h2 className="cx-h2" id="cx-upload-h">1. Your file</h2>
      <input ref={input} type="file" hidden data-testid="file-input" aria-label="Choose file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />

      {(state.phase === 'idle') && (
        <div className={`cx-drop${drag ? ' is-drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          <button type="button" className="cx-btn cx-btn-primary cx-btn-lg" onClick={pick}>Choose file</button>
          <p className="cx-muted cx-drop-hint"><span className="cx-wide-only">or drag and drop it here. </span>PDF, JPG or PNG, up to {formatBytes(limits.maxBytes)}.</p>
        </div>
      )}

      {file && (
        <div className="cx-file">
          <div className="cx-file-name" title={file.name}>{file.name}</div>
          <div className="cx-muted">{formatBytes(file.size)}</div>
        </div>
      )}

      {busy && (
        <div className="cx-progress-wrap">
          <div role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={pct} className={`cx-progress${state.phase === 'verifying' ? ' is-indeterminate' : ''}`}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="cx-row cx-between" aria-live="polite">
            <span className="cx-tnum">{state.phase === 'verifying' ? 'Checking your file…' : state.phase === 'uploading' ? `Uploading ${pct}%` : 'Preparing…'}</span>
            {state.phase !== 'verifying' && <button type="button" className="cx-btn cx-btn-quiet" onClick={onCancel}>Cancel</button>}
          </div>
        </div>
      )}

      {state.phase === 'ready' && (
        <div className="cx-ready" aria-live="polite">
          <span className="cx-ok-dot" aria-hidden="true" />
          <span><strong className="cx-tnum">{state.doc.pageCount ?? '?'}</strong> {state.doc.pageCount === 1 ? 'page' : 'pages'} · ready</span>
          <button type="button" className="cx-btn cx-btn-quiet cx-push" onClick={onReplace}>Replace file</button>
        </div>
      )}

      {state.phase === 'error' && (
        <div>
          <Alert>{state.message}</Alert>
          <div className="cx-row cx-gap">
            {state.file && state.code !== 'INVALID_FILE_TYPE' && state.code !== 'FILE_TOO_LARGE' && state.code !== 'EMPTY_FILE' && state.code !== 'SHOP_UNAVAILABLE'
              && <button type="button" className="cx-btn cx-btn-primary" onClick={onRetry}>Try again</button>}
            <button type="button" className="cx-btn" onClick={pick}>Choose a different file</button>
          </div>
        </div>
      )}
    </section>
  );
}
