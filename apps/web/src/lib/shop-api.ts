import { api, ApiError, setCsrfToken } from './api';

export type OrderStatus = 'NEW' | 'ACCEPTED' | 'PRINTING' | 'PRINTED' | 'READY' | 'COLLECTED' | 'CANCELLED' | 'EXPIRED';
export const ALL_STATUSES: OrderStatus[] = ['NEW', 'ACCEPTED', 'PRINTING', 'PRINTED', 'READY', 'COLLECTED', 'CANCELLED', 'EXPIRED'];

export interface SessionData {
  user: { id: string; displayName: string; role: 'SHOP_OWNER' | 'PLATFORM_ADMIN' };
  shop?: { id: string; slug: string; displayName: string } | null;
  csrfToken: string;
  /** Server retention policy in minutes (display wording only). Absent on older APIs. */
  retentionMinutes?: number;
}
export interface OrderSummary {
  id: string; orderNumber: string; status: OrderStatus; totalPaise: number; createdAt: string; updatedAt?: string;
  documentStatus?: string; originalFilename?: string | null; pageCount?: number | null; selectedPageCount?: number | null;
  colourMode?: 'bw' | 'colour'; sides?: 'single' | 'duplex'; copies?: number;
  customerDisplayNameOrReference?: string | null; deleteAfter?: string | null;
  /** Server time of the first successful Print (starts retention). Does NOT prove paper printed. */
  printInitiatedAt?: string | null; paperSize?: string | null;
  pageSelection?: { mode: 'all' } | { mode: 'ranges'; ranges: { from: number; to: number }[] } | null;
}
export interface OrderListPage { items: OrderSummary[]; nextCursor?: string | undefined }
export interface DocumentInfo {
  id?: string; status: string; pageCount?: number | null; uploadedAt?: string | null; expiresAt?: string | null;
  printedAt?: string | null; printInitiatedAt?: string | null; deleteAfter?: string | null; deletedAt?: string | null; deletionState?: string; originalFilename?: string | null;
}
export interface PrintOptionsSnapshot {
  paperSize?: string; colourMode?: 'bw' | 'colour'; sides?: 'single' | 'duplex'; copies?: number;
  pageSelection?: { mode: 'all' } | { mode: 'ranges'; ranges: { from: number; to: number }[] };
}
export interface PriceSnapshot {
  selectedPageCount?: number; sheetsPerCopy?: number; totalSheets?: number; unitPricePaise?: number; totalPaise?: number; currency?: string;
}
export interface HistoryEntry { id?: string; fromStatus?: OrderStatus | null; toStatus: OrderStatus; reason?: string | null; createdAt: string }
export interface OrderDetail {
  order: OrderSummary & Record<string, unknown>;
  document: DocumentInfo;
  priceSnapshot?: PriceSnapshot | null;
  printOptionsSnapshot?: PrintOptionsSnapshot | null;
  statusHistory: HistoryEntry[];
}
export interface PricingRule { id: string; paperSize: 'A4'; colourMode: 'bw' | 'colour'; sides: 'single' | 'duplex'; pricePerSheetPaise: number; active: boolean }
export interface ShopSettings {
  displayName?: string | null; address?: string | null; publicContact?: string | null; brandColor?: string | null; acceptsOrders?: boolean;
}
export interface QrInfo { publicUrl: string; slug: string; shopName?: string }

// ---- global session hooks (set by the auth provider) -------------------------------------------------
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null) => { onUnauthorized = fn; };

/** Request wrapper: 401 mid-session -> global handler; 403 CSRF_INVALID -> refresh session once, retry GETs only. */
export async function shopRequest<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  try {
    return await api<T>(path, init);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) { onUnauthorized?.(); throw e; }
      if (e.status === 403 && e.code === 'CSRF_INVALID') {
        try {
          const s = await api<SessionData>('/auth/session');
          setCsrfToken(s.csrfToken);
        } catch (e2) {
          if (e2 instanceof ApiError && e2.status === 401) onUnauthorized?.();
          throw e;
        }
        if (method === 'GET') return api<T>(path, init);
      }
    }
    throw e;
  }
}

export const newRequestId = (): string =>
  (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });

/** Readable copy for every error the shop UI can meet. */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch (e.code) {
    case 'NETWORK_ERROR': return 'Cannot reach the server. Check your connection and try again.';
    case 'RATE_LIMITED': return 'Too many requests. Wait a moment and try again.';
    case 'CSRF_INVALID': return 'Your security token was refreshed. Please try again.';
    case 'UNAUTHENTICATED': case 'UNAUTHORIZED': return 'Session expired — sign in again.';
    case 'INVALID_STATUS_TRANSITION': return 'That order has already moved on or cannot take that step. Showing the latest status.';
    case 'DOCUMENT_UNAVAILABLE': return 'The document is no longer available. It may have been deleted.';
    case 'ORDER_NOT_FOUND': case 'NOT_FOUND': return 'Not found. It may have been removed.';
    case 'SHOP_UNAVAILABLE': case 'SHOP_SUSPENDED': return 'This shop is suspended or unavailable. Contact support.';
    case 'VALIDATION_ERROR': return 'Some values are not valid. Check the fields and try again.';
    case 'FORBIDDEN': return 'You do not have permission to do that.';
    default:
  }
  if (e.status === 429) return 'Too many requests. Wait a moment and try again.';
  if (e.status === 410) return 'The document is no longer available. It has been deleted.';
  if (e.status === 404) return 'Not found. It may have been removed.';
  if (e.status === 409) return e.message || 'That action conflicts with the current state. Showing the latest status.';
  if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
  return e.message || 'Request failed. Please try again.';
}
export const errorCode = (e: unknown) => (e instanceof ApiError ? e.code : '');

// ---- endpoints ---------------------------------------------------------------------------------------
export const fetchSession = () => api<SessionData>('/auth/session');
export const login = (email: string, password: string) =>
  api<SessionData>('/auth/login', { method: 'POST', body: { email, password } });
export const logout = () => api<void>('/auth/logout', { method: 'POST', body: {} });

export interface OrderQuery { status?: string; active?: boolean; print?: 'pending' | 'initiated'; cursor?: string | undefined }
/** `status` may be one status or a comma-separated list; `active` hides terminal orders (both documented by the API). */
export function listOrders(params: OrderQuery = {}, signal?: AbortSignal) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.active) q.set('active', '1');
  if (params.print) q.set('print', params.print);
  if (params.cursor) q.set('cursor', params.cursor);
  const qs = q.toString();
  return shopRequest<OrderListPage>(`/shop/orders${qs ? `?${qs}` : ''}`, signal ? { signal } : {});
}
export const getOrder = (id: string, signal?: AbortSignal) =>
  shopRequest<OrderDetail>(`/shop/orders/${encodeURIComponent(id)}`, signal ? { signal } : {});
/** Shop owners can only cancel; every other lifecycle step is retired (Print does the internal steps itself). */
export const transitionOrder = (id: string, toStatus: 'CANCELLED', reason?: string) =>
  shopRequest<{ order: OrderSummary }>(`/shop/orders/${encodeURIComponent(id)}/transitions`, {
    method: 'POST', body: { toStatus, clientRequestId: newRequestId(), ...(reason ? { reason } : {}) }
  });
/**
 * The ONE shop action. The first successful call starts the retention window (document.printInitiatedAt, deleteAfter = +30 min)
 * and returns short-lived INLINE access; later calls (Reprint) only return access and never move either timestamp.
 * It does not mean paper printed.
 */
export const printNow = (id: string) =>
  shopRequest<{
    order: { id: string; orderNumber: string; status: OrderStatus }; transitioned: boolean; firstPrint?: boolean;
    document?: { status: string; printInitiatedAt: string | null; deleteAfter: string | null };
    access: { url: string; expiresAt: string; contentDisposition?: string };
  }>(`/shop/orders/${encodeURIComponent(id)}/print-now`, { method: 'POST', body: { clientRequestId: newRequestId() } });
/** Explicit "Save File": short-lived ATTACHMENT url for the original document (never automatic). */
export const requestDocumentDownload = (id: string) =>
  shopRequest<{ url: string; expiresAt: string; contentDisposition?: string; fileName: string }>(
    `/shop/orders/${encodeURIComponent(id)}/document-download`, { method: 'POST', body: {} });
export const requestDocumentAccess = (id: string) =>
  shopRequest<{ url: string; expiresAt: string; contentDisposition?: string }>(
    `/shop/orders/${encodeURIComponent(id)}/document-access`, { method: 'POST', body: {} });

export async function listPricingRules(): Promise<PricingRule[]> {
  const r = await shopRequest<PricingRule[] | { items?: PricingRule[]; rules?: PricingRule[] }>('/shop/pricing-rules');
  return Array.isArray(r) ? r : (r.items ?? r.rules ?? []);
}
export const createPricingRule = (rule: Omit<PricingRule, 'id'>) =>
  shopRequest<PricingRule>('/shop/pricing-rules', { method: 'POST', body: rule });
export const updatePricingRule = (id: string, patch: Partial<Pick<PricingRule, 'pricePerSheetPaise' | 'active'>>) =>
  shopRequest<PricingRule>(`/shop/pricing-rules/${encodeURIComponent(id)}`, { method: 'PUT', body: patch });
export const deletePricingRule = (id: string) =>
  shopRequest<void>(`/shop/pricing-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getQr = () => shopRequest<QrInfo>('/shop/qr');
// ---- order history (metadata only; dates are Asia/Kolkata calendar days, YYYY-MM-DD, inclusive) -------------------
export interface HistoryItem {
  id: string; orderNumber: string; status: OrderStatus; createdAt: string; originalFilename: string;
  pageCount: number | null; selectedPageCount: number | null; copies: number | null;
  colourMode: 'bw' | 'colour' | null; sides: 'single' | 'duplex' | null; paperSize: string | null; totalPaise: number;
  /** First Print press (server time). Does NOT prove paper came out. */
  printInitiatedAt: string | null; documentStatus: string; fileDeletedAt: string | null; handledBy: string | null;
}
export interface HistoryPage { range: { from: string; to: string; timezone: string }; items: HistoryItem[]; nextCursor?: string | undefined }
export interface HistorySummary {
  timezone: string; range: { from: string; to: string }; total: number; byStatus: Record<OrderStatus, number>; printInitiated: number; filesDeleted: number;
}
export interface HistoryQuery { from: string; to: string; status?: string; q?: string; cursor?: string | undefined; limit?: number }

function historyParams(p: HistoryQuery, withPaging: boolean): string {
  const q = new URLSearchParams({ from: p.from, to: p.to });
  if (p.status) q.set('status', p.status);
  if (p.q?.trim()) q.set('q', p.q.trim());
  if (withPaging && p.cursor) q.set('cursor', p.cursor);
  if (withPaging && p.limit) q.set('limit', String(p.limit));
  return q.toString();
}
export const listHistory = (p: HistoryQuery, signal?: AbortSignal) =>
  shopRequest<HistoryPage>(`/shop/orders/history?${historyParams(p, true)}`, signal ? { signal } : {});
export const getHistorySummary = (p: HistoryQuery, signal?: AbortSignal) =>
  shopRequest<HistorySummary>(`/shop/orders/history/summary?${historyParams(p, false)}`, signal ? { signal } : {});

/** Fetches the CSV with the session cookie (an authenticated GET), so failures surface as ApiError instead of a broken download. */
export async function fetchHistoryCsv(p: HistoryQuery): Promise<{ blob: Blob; filename: string; truncated: boolean }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/shop/orders/history/export.csv?${historyParams(p, false)}`, { credentials: 'include' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    const err = new ApiError(res.status, json?.error?.code ?? 'REQUEST_ERROR', json?.error?.message ?? `Request failed (${res.status})`, json?.error?.details, json?.error?.requestId);
    if (res.status === 401) onUnauthorized?.();
    throw err;
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  return { blob: await res.blob(), filename: name ?? `order-history-${p.from}_to_${p.to}.csv`, truncated: res.headers.get('x-export-truncated') === 'true' };
}

// ---- estimated order value report (Asia/Kolkata calendar days, inclusive). Quotes only: no customer payments are recorded. ----
export interface RevenueBucket { key: string; orders: number; valuePaise: number; pages: number }
export interface RevenueTotals {
  orderCount: number; countedOrders: number; estimatedOrderValuePaise: number; averageEstimatedOrderValuePaise: number | null; pagesRequested: number;
  ordersWithUnknownPages: number; zeroValueOrders: number; printStarted: number; cancelled: number; expired: number; excludedQuotedValuePaise: number;
}
export interface RevenueDay { date: string; orders: number; countedOrders: number; estimatedOrderValuePaise: number; pagesRequested: number }
export interface RevenueReport {
  timezone: string;
  range: { from: string; to: string; days: number };
  basis: 'ESTIMATED_ORDER_VALUE';
  collected: { available: false; reason: string };
  totals: RevenueTotals;
  daily: RevenueDay[];
  breakdown: { colourMode: RevenueBucket[]; sides: RevenueBucket[]; paperSize: RevenueBucket[]; status: RevenueBucket[] };
  comparison: {
    previousRange: { from: string; to: string };
    available: boolean;
    reason: 'NO_PREVIOUS_ORDERS' | 'PREVIOUS_PERIOD_INCOMPLETE' | null;
    previous: RevenueTotals;
    changePct: { estimatedOrderValue: number | null; orderCount: number | null; pagesRequested: number | null };
  };
}
export interface RevenueQuery { from: string; to: string }
export const getRevenue = (p: RevenueQuery, signal?: AbortSignal) =>
  shopRequest<RevenueReport>(`/shop/analytics/revenue?${new URLSearchParams({ from: p.from, to: p.to })}`, signal ? { signal } : {});

/** Same authenticated-GET download pattern as the history export, so failures surface as ApiError instead of a broken download. */
export async function fetchRevenueCsv(p: RevenueQuery): Promise<{ blob: Blob; filename: string; truncated: boolean }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/shop/analytics/revenue/export.csv?${new URLSearchParams({ from: p.from, to: p.to })}`, { credentials: 'include' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    const err = new ApiError(res.status, json?.error?.code ?? 'REQUEST_ERROR', json?.error?.message ?? `Request failed (${res.status})`, json?.error?.details, json?.error?.requestId);
    if (res.status === 401) onUnauthorized?.();
    throw err;
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  return { blob: await res.blob(), filename: name ?? `estimated-order-value-${p.from}_to_${p.to}.csv`, truncated: res.headers.get('x-export-truncated') === 'true' };
}

export const getAnalytics = () => shopRequest<Record<string, unknown>>('/shop/analytics');
export const getSettings = () => shopRequest<ShopSettings | null>('/shop/settings');
export const putSettings = (s: ShopSettings) => shopRequest<ShopSettings>('/shop/settings', { method: 'PUT', body: s });

// ---- printing devices (Settings -> Printing Devices) ---------------------------------------------------
export type DevicePlatform = 'ANDROID' | 'WINDOWS';
export type DeviceStatus = 'ACTIVE' | 'REVOKED';
export type DevicePresence = 'ONLINE' | 'OFFLINE' | 'REVOKED';
/** Owner-safe device shape. Presence is derived by the server from the last heartbeat (not real-time). Never carries secrets. */
export interface DeviceView {
  id: string; name: string; platform: DevicePlatform; status: DeviceStatus; presence: DevicePresence;
  lastSeenAt: string | null; createdAt: string; revokedAt: string | null; appVersion: string | null;
}
/** The raw pairing code is returned exactly once; keep it in component state only. */
export interface PairingCode { code: string; expiresAt: string }

export const listDevices = (signal?: AbortSignal) =>
  shopRequest<{ devices: DeviceView[] }>('/shop/devices', signal ? { signal } : {});
export const createPairingCode = () =>
  shopRequest<PairingCode>('/shop/devices/pairing-codes', { method: 'POST', body: {} });
export const renameDevice = (id: string, name: string) =>
  shopRequest<{ device: DeviceView }>(`/shop/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
export const revokeDevice = (id: string) =>
  shopRequest<{ device: DeviceView }>(`/shop/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} });
