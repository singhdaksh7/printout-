import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_LIMITS, completeUpload, customerErrorMessage, messageForCode, initiateUpload, isAbort, putFile, requestQuote,
  type CompleteResult, type PrintOptions, type Quote, type UploadLimits
} from '../lib/customer-api';

export function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

const EXT_MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

export function declaredMime(file: { name: string; type: string }, limits: UploadLimits = DEFAULT_LIMITS): string | null {
  if (limits.acceptedMimeTypes.includes(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const m = EXT_MIME[ext];
  return m && limits.acceptedMimeTypes.includes(m) && (file.type === '' || file.type === 'application/octet-stream') ? m : null;
}

/** Fast client-side feedback only; the server is authoritative. Returns an error code or null. */
export function validateFile(file: { name: string; size: number; type: string }, limits: UploadLimits = DEFAULT_LIMITS): string | null {
  if (file.size === 0) return 'EMPTY_FILE';
  if (!declaredMime(file, limits)) return 'INVALID_FILE_TYPE';
  if (file.size > limits.maxBytes) return 'FILE_TOO_LARGE';
  return null;
}

export type UploadState =
  | { phase: 'idle' }
  | { phase: 'validating' | 'uploading' | 'verifying'; file: File; progress: number }
  | { phase: 'ready'; file: File; doc: CompleteResult }
  | { phase: 'error'; file: File | null; code: string; message: string };

export function useUpload(slug: string) {
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const [limits, setLimits] = useState<UploadLimits>(DEFAULT_LIMITS);
  const ctl = useRef<AbortController | null>(null);
  const run = useRef(0);
  const lastFile = useRef<File | null>(null);

  useEffect(() => () => ctl.current?.abort(), []);

  const start = useCallback(async (file: File) => {
    ctl.current?.abort();
    const my = ++run.current;
    const c = new AbortController();
    ctl.current = c;
    lastFile.current = file;
    const live = () => run.current === my;
    setState({ phase: 'validating', file, progress: 0 });
    const bad = validateFile(file, limits);
    if (bad) { setState({ phase: 'error', file, code: bad, message: messageForCode(bad) }); return; }
    try {
      const init = await initiateUpload(slug, { fileName: file.name, byteSize: file.size, declaredMimeType: declaredMime(file, limits)! }, c.signal);
      if (!live()) return;
      const lim = { ...limits, ...(init.limits ?? {}) } as UploadLimits;
      setLimits(lim);
      setState({ phase: 'uploading', file, progress: 0 });
      await putFile(init.uploadUrl, file, init.requiredHeaders ?? { 'content-type': declaredMime(file, limits)! },
        (f) => { if (live()) setState({ phase: 'uploading', file, progress: f }); }, c.signal);
      if (!live()) return;
      setState({ phase: 'verifying', file, progress: 1 });
      const doc = await completeUpload(slug, init.uploadId, c.signal);
      if (!live()) return;
      setState({ phase: 'ready', file, doc });
    } catch (e) {
      if (!live()) return;
      if (isAbort(e)) { setState({ phase: 'idle' }); return; }
      setState({ phase: 'error', file, ...customerErrorMessage(e, 'upload') });
    }
  }, [slug, limits]);

  const cancel = useCallback(() => { run.current++; ctl.current?.abort(); setState({ phase: 'idle' }); }, []);
  const retry = useCallback(() => { if (lastFile.current) void start(lastFile.current); }, [start]);
  const reset = cancel;
  return { state, limits, start, cancel, retry, reset };
}

export type QuoteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; quote: Quote }
  | { status: 'error'; code: string; message: string };

/** Debounced live quote. Stale responses are ignored; in-flight requests are aborted. Re-quotes automatically at expiry. */
export function useQuote(slug: string, documentId: string | null, options: PrintOptions | null, debounceMs = 400) {
  const [raw, setState] = useState<{ forKey: string | null; s: QuoteState }>({ forKey: null, s: { status: 'idle' } });
  const [nonce, setNonce] = useState(0);
  const key = useMemo(() => (documentId && options ? JSON.stringify([documentId, options]) : null), [documentId, options]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!key || !documentId || !optionsRef.current) { setState({ forKey: null, s: { status: 'idle' } }); return; }
    setState({ forKey: key, s: { status: 'loading' } });
    const c = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const quote = await requestQuote(slug, { documentId, printOptions: optionsRef.current! }, c.signal);
        if (cancelled) return;
        setState({ forKey: key, s: { status: 'ready', quote } });
        const ms = new Date(quote.expiresAt).getTime() - Date.now() - 5000;
        if (Number.isFinite(ms)) expiryTimer = setTimeout(() => { if (!cancelled) setNonce((n) => n + 1); }, Math.max(1000, ms));
      } catch (e) {
        if (cancelled || isAbort(e)) return;
        setState({ forKey: key, s: { status: 'error', ...customerErrorMessage(e, 'quote') } });
      }
    }, debounceMs);
    return () => { cancelled = true; c.abort(); clearTimeout(timer); if (expiryTimer) clearTimeout(expiryTimer); };
  }, [key, nonce, slug, documentId, debounceMs]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // Never expose a result computed for different options than the current ones.
  const state: QuoteState = !key ? { status: 'idle' } : raw.forKey === key ? raw.s : { status: 'loading' };
  return { state, refresh };
}

export function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
