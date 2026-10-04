import { api, ApiError } from './api';
import type { PageRange } from './customer-pages';

export type PageSelection = { mode: 'all' } | { mode: 'ranges'; ranges: PageRange[] };
export type PrintOptions = { paperSize: 'A4'; colourMode: 'bw' | 'colour'; sides: 'single' | 'duplex'; copies: number; pageSelection: PageSelection };

export type UploadLimits = { acceptedMimeTypes: string[]; maxBytes: number; maxPdfPages: number; imagePageCount: number };
export const DEFAULT_LIMITS: UploadLimits = { acceptedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 52428800, maxPdfPages: 200, imagePageCount: 1 };

export type PublicShop = { slug: string; displayName: string; address?: string | null; acceptsOrders: boolean; status?: string; retentionMinutes?: number };
export type InitiateResult = { uploadId: string; uploadUrl: string; requiredHeaders?: Record<string, string>; expiresAt: string; limits?: Partial<UploadLimits> };
export type CompleteResult = { documentId: string; detectedMimeType: string; byteSize: number; pageCount: number | null; expiresAt: string; documentStatus?: string };
export type Quote = { quoteId: string; selectedPageCount: number; sheetsPerCopy: number; totalSheets: number; unitPricePaise: number; totalPaise: number; currency: string; expiresAt: string; printOptions?: PrintOptions };
export type OrderResult = { orderNumber: string; trackingToken: string; status: string; totalPaise: number; currency?: string };

export type OrderStatus = 'NEW' | 'ACCEPTED' | 'PRINTING' | 'PRINTED' | 'READY' | 'COLLECTED' | 'CANCELLED' | 'EXPIRED';
export type HistoryEntry = { status?: string; toStatus?: string; at?: string; createdAt?: string };
export type TrackedOrder = {
  orderNumber: string; shopName: string; status: OrderStatus; totalPaise: number; currency?: string; updatedAt?: string;
  // Additive / optional fields; the UI renders whatever the server provides.
  documentDeleteAfter?: string | null;
  documentStatus?: string | null;
  documentDeletedAt?: string | null;
  serverTime?: string;
  shopSlug?: string;
  retentionMinutes?: number;
  printOptions?: Partial<PrintOptions> | null;
  selectedPageCount?: number | null;
  totalSheets?: number | null;
  createdAt?: string;
  statusHistory?: HistoryEntry[];
  // Shape currently returned by the API (normalised into the fields above by getTrackedOrder).
  timeline?: HistoryEntry[];
  document?: { fileName?: string | null; pageCount?: number | null; status?: string | null; deleteAfter?: string | null; deletedAt?: string | null } | null;
};

function normaliseOrder(o: TrackedOrder): TrackedOrder {
  return {
    ...o,
    documentDeleteAfter: o.documentDeleteAfter ?? o.document?.deleteAfter ?? null,
    documentStatus: o.documentStatus ?? o.document?.status ?? null,
    documentDeletedAt: o.documentDeletedAt ?? o.document?.deletedAt ?? null,
    statusHistory: o.statusHistory ?? o.timeline
  };
}

const base = (slug: string) => `/public/shops/${encodeURIComponent(slug)}`;

export const getShop = (slug: string, signal?: AbortSignal) => api<PublicShop>(base(slug), { signal });
export const initiateUpload = (slug: string, body: { fileName: string; byteSize: number; declaredMimeType: string }, signal?: AbortSignal) =>
  api<InitiateResult>(`${base(slug)}/uploads/initiate`, { method: 'POST', body, signal });
export const completeUpload = (slug: string, uploadId: string, signal?: AbortSignal) =>
  api<CompleteResult>(`${base(slug)}/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', body: {}, signal });
export const requestQuote = (slug: string, body: { documentId: string; printOptions: PrintOptions }, signal?: AbortSignal) =>
  api<Quote>(`${base(slug)}/quotes`, { method: 'POST', body, signal });
export const submitOrder = (slug: string, body: { quoteId: string; customerDisplayNameOrReference?: string; clientRequestId: string }, signal?: AbortSignal) =>
  api<OrderResult>(`${base(slug)}/orders`, { method: 'POST', body, signal });
export const getTrackedOrder = async (token: string, signal?: AbortSignal) =>
  normaliseOrder(await api<TrackedOrder>(`/public/orders/${encodeURIComponent(token)}`, { signal }));

/** PUT the raw file with real progress. Resolves on 2xx; rejects with ApiError. `abort()` rejects with AbortError. */
export function putFile(url: string, file: Blob, headers: Record<string, string>, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abortError = () => Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() !== 'content-length') xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); return resolve(); }
      let err: { code?: string; message?: string } | undefined;
      try { err = JSON.parse(xhr.responseText)?.error; } catch { /* non-JSON body */ }
      reject(new ApiError(xhr.status, err?.code ?? (xhr.status === 413 ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED'), err?.message ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Network error during upload'));
    xhr.ontimeout = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Upload timed out'));
    xhr.onabort = () => reject(abortError());
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

const MESSAGES: Record<string, string> = {
  INVALID_FILE_TYPE: 'That file type is not supported. Please choose a PDF, JPG or PNG.',
  FILE_TOO_LARGE: 'That file is too large. The limit is 50 MB.',
  EMPTY_FILE: 'That file is empty. Please choose a different file.',
  PDF_TOO_MANY_PAGES: 'That PDF has too many pages. Please split it into smaller files.',
  INVALID_PDF: 'We could not read that PDF. It may be damaged. Try saving it again.',
  PASSWORD_PROTECTED_PDF: 'That PDF is password protected. Remove the password and try again.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  NETWORK_ERROR: 'Cannot reach the server. Check your connection and try again.',
  SHOP_UNAVAILABLE: 'This shop is not accepting orders right now.',
  INVALID_PAGE_RANGE: 'Those pages are not valid for this document. Check the page numbers.',
  NO_PRICING_RULE: "This shop hasn't set a price for that option. Try a different combination.",
  QUOTE_EXPIRED: 'Your price quote expired. We are refreshing it.',
  INVALID_QUOTE: 'Your price quote is no longer valid. We are refreshing it.',
  DOCUMENT_UNAVAILABLE: 'Your file is no longer available. Please upload it again.',
  VALIDATION_ERROR: 'Something in the request was not accepted. Please check your choices.',
  DOCUMENT_ALREADY_USED: 'This file already has an order. Upload it again to place another.',
  IDEMPOTENCY_CONFLICT: 'Something changed since you last tried. Please review and place the order again.',
  UPLOAD_FAILED: 'The upload failed. Please try again.'
};

export const messageForCode = (code: string, fallback = 'Something went wrong. Please try again.') => MESSAGES[code] ?? fallback;

export function customerErrorMessage(e: unknown, context?: 'upload' | 'quote' | 'order'): { code: string; message: string } {
  if (e instanceof ApiError) {
    let code = e.code;
    if (context === 'upload' && (code === 'NOT_FOUND' || e.status === 404)) code = 'SHOP_UNAVAILABLE';
    if (code === 'REQUEST_ERROR' && e.status === 429) code = 'RATE_LIMITED';
    if (context === 'upload' && e.status === 422 && code === 'REQUEST_ERROR') code = 'INVALID_FILE_TYPE';
    return { code, message: MESSAGES[code] ?? e.message ?? 'Something went wrong. Please try again.' };
  }
  return { code: 'UNKNOWN', message: 'Something went wrong. Please try again.' };
}

export const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';
