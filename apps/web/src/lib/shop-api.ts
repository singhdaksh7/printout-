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
