import { api, ApiError, setCsrfToken } from './api';
import type { AfterHoursPolicy, Availability, SpecialClosure, WeeklyHours } from './hours';

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
/** An admin with two-factor enabled gets this instead of a session: a code is still required (see verifySecondFactor). */
export interface TwoFactorRequired { twoFactorRequired: true; expiresInSeconds: number }
export type LoginResult = SessionData | TwoFactorRequired;
export const isTwoFactorRequired = (r: LoginResult): r is TwoFactorRequired => 'twoFactorRequired' in r && r.twoFactorRequired === true;
export type SecondFactorMethod = 'totp' | 'recovery';
export const login = (email: string, password: string) =>
  api<LoginResult>('/auth/login', { method: 'POST', body: { email, password } });
/** Second step of an admin sign-in; the pending-challenge cookie set by login() identifies the attempt. */
export const verifySecondFactor = (method: SecondFactorMethod, code: string) =>
  api<SessionData & { recoveryCodesRemaining?: number }>('/auth/login/2fa', { method: 'POST', body: { method, code } });
export const cancelSecondFactor = () => api<void>('/auth/login/2fa/cancel', { method: 'POST', body: {} });
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
// ---- operating hours (Settings -> Operating hours) ---------------------------------------------------
export interface TemporaryClosure { reason?: string | null; startedAt: string; until?: string | null }
export interface ShopHours {
  timezone: string;
  weeklyHours: WeeklyHours | null;
  specialClosures: SpecialClosure[];
  afterHoursPolicy: AfterHoursPolicy;
  temporaryClosure: TemporaryClosure | null;
  reopenUntil: string | null;
  availability: Availability;
}
export type HoursUpdate = Partial<{ timezone: string; weeklyHours: WeeklyHours | null; specialClosures: SpecialClosure[]; afterHoursPolicy: AfterHoursPolicy }>;
export const getHours = () => shopRequest<ShopHours>('/shop/hours');
export const putHours = (b: HoursUpdate) => shopRequest<ShopHours>('/shop/hours', { method: 'PUT', body: b });
export const setTemporaryClosure = (b: { reason?: string | null; until?: string | null }) => shopRequest<ShopHours>('/shop/hours/temporary-closure', { method: 'PUT', body: b });
export const clearTemporaryClosure = () => shopRequest<ShopHours>('/shop/hours/temporary-closure', { method: 'DELETE' });
export const startReopen = (minutes: number) => shopRequest<ShopHours>('/shop/hours/reopen', { method: 'POST', body: { minutes } });
export const endReopen = () => shopRequest<ShopHours>('/shop/hours/reopen', { method: 'DELETE' });

export const putSettings = (s: ShopSettings) => shopRequest<ShopSettings>('/shop/settings', { method: 'PUT', body: s });

// ---- printing devices (Settings -> Printing Devices) ---------------------------------------------------
export type DevicePlatform = 'ANDROID' | 'WINDOWS';
export type DeviceStatus = 'ACTIVE' | 'REVOKED';
export type DevicePresence = 'ONLINE' | 'OFFLINE' | 'REVOKED';
/** Owner-safe device shape. Presence is derived by the server from the last heartbeat (not real-time). Never carries secrets. */
export interface DeviceView {
  id: string; name: string; platform: DevicePlatform; status: DeviceStatus; presence: DevicePresence;
  lastSeenAt: string | null; createdAt: string; revokedAt: string | null; appVersion: string | null;
  /** Windows agents only: printers the computer reports. */
  printers?: PrinterView[];
}
export interface PrinterView {
  id: string; deviceId: string; name: string; driverName: string | null;
  connectivity: 'ONLINE' | 'OFFLINE' | 'ERROR' | 'UNKNOWN'; statusDetail: string | null;
  supportsColour: boolean; supportsDuplex: boolean; paperSizes: string[];
  /** false when the computer no longer reports it (uninstalled). */
  present: boolean;
  /** Owner decisions: the agent may only print on an authorized printer. */
  authorized: boolean; isDefault: boolean; lastReportedAt: string;
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

// ---- Windows print queue (print jobs) ------------------------------------------------------------------
/** There is deliberately no "printed" status: PRINT_INITIATED means the Windows print queue accepted the job. */
export type PrintJobStatus =
  | 'QUEUED' | 'CLAIMED' | 'DOWNLOADING' | 'SUBMITTING' | 'SUBMITTED_TO_SPOOLER' | 'PRINT_INITIATED'
  | 'FAILED' | 'CANCEL_REQUESTED' | 'CANCELED' | 'NEEDS_RECONCILIATION';
export interface PrintJobView {
  id: string; orderId: string; deviceId: string; printerId: string; printerName: string | null; status: PrintJobStatus; attempt: number;
  spoolerJobId: number | null; spoolerState: string | null; errorCode: string | null; errorMessage: string | null;
  /** A retry could print pages twice (the job may have reached the printer). */
  duplicateRisk: boolean; needsReconciliation: boolean; resolution: string | null;
  printInitiatedAt: string | null; createdAt: string; updatedAt: string;
}
export type Reconciliation = 'PRINTED' | 'NOT_PRINTED_REQUEUE' | 'NOT_PRINTED_GIVE_UP';

export const updatePrinter = (deviceId: string, printerId: string, patch: { authorized?: boolean; isDefault?: boolean }) =>
  shopRequest<{ printer: PrinterView }>(`/shop/devices/${encodeURIComponent(deviceId)}/printers/${encodeURIComponent(printerId)}`, { method: 'PATCH', body: patch });
export const listPrintJobs = (orderId?: string, signal?: AbortSignal) =>
  shopRequest<{ jobs: PrintJobView[] }>(`/shop/print-jobs${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ''}`, signal ? { signal } : {});
export const enqueuePrintJob = (orderId: string, opts: { printerId?: string; reprint?: boolean; acknowledgeDuplicateRisk?: boolean } = {}) =>
  shopRequest<{ job: PrintJobView; created: boolean }>(`/shop/orders/${encodeURIComponent(orderId)}/print-jobs`, { method: 'POST', body: { clientRequestId: newRequestId(), ...opts } });
export const cancelPrintJob = (id: string) =>
  shopRequest<{ job: PrintJobView }>(`/shop/print-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
export const retryPrintJob = (id: string, acknowledgeDuplicateRisk = false) =>
  shopRequest<{ job: PrintJobView }>(`/shop/print-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: { clientRequestId: newRequestId(), ...(acknowledgeDuplicateRisk ? { acknowledgeDuplicateRisk: true } : {}) } });
export const reconcilePrintJob = (id: string, resolution: Reconciliation) =>
  shopRequest<{ job: PrintJobView; next: PrintJobView | null }>(`/shop/print-jobs/${encodeURIComponent(id)}/reconcile`, {
    method: 'POST', body: { resolution, ...(resolution === 'NOT_PRINTED_REQUEUE' ? { clientRequestId: newRequestId() } : {}) }
  });

// ---- phone (SMS OTP) sign-in ---------------------------------------------------------------------------
export interface PhoneLoginConfig { enabled: boolean; allowedCallingCodes: string[]; defaultCallingCode: string; resendCooldownSeconds: number }
export const getPhoneLoginConfig = () => api<PhoneLoginConfig>('/auth/phone/config');
export interface UserProfileView {
  id: string | null;
  role: 'shop' | 'admin' | null;
  name: string | null;
  email: string | null;
  phoneNumber: string | null;
  loginMethods: Array<'email' | 'otp' | 'google'>;
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastLoginAt: string | null;
}

export interface WebAuthProfileResponse {
  user: UserProfileView;
  shops: Array<{ id: string; shopName: string; slug: string; status: string }>;
  shop: { id: string; shopName: string; slug: string; status: string } | null;
  nextStep: string;
  isShopRegisteredAtLeastOne: boolean;
  showQr: boolean;
  session?: { transport: 'cookie'; expiresAt: string } | null;
  onboarding?: { transport: 'cookie'; expiresAt: string } | null;
  csrfToken?: string;
  retentionMinutes?: number;
  onboardingAvailable?: boolean;
}

export type GoogleSessionResponse = SessionData | WebAuthProfileResponse;

/** Exchanges a Firebase ID token for a normal shop session. The token is the only proof sent; no phone, role or shop id. */
export const phoneSession = (idToken: string) => api<SessionData>('/auth/phone/session', { method: 'POST', body: { idToken } });
/** Exchanges a Firebase Google ID token for a normal shop session or a restricted onboarding grant. */
export const googleSession = (idToken: string) => api<GoogleSessionResponse>('/auth/google/session', { method: 'POST', body: { idToken } });

export interface OnboardShopInput {
  ownerName: string;
  shopName: string;
  address: string;
  pincode: string;
  email?: string;
}

export interface OnboardShopResponse {
  user: { id: string; role: 'shop'; name: string | null; email: string | null };
  shop: { id: string; shopName: string; slug: string; status: string } | null;
  csrfToken: string;
  retentionMinutes?: number;
}

export const onboardShop = (input: OnboardShopInput) =>
  api<OnboardShopResponse>('/shops/onboarding', {
    method: 'POST',
    body: { ...input, client: 'web' }
  });

export const getMyProfile = () => api<WebAuthProfileResponse>('/users/me');

export interface PhoneStatus { linked: boolean; phoneMasked?: string; linkedAt?: string; lastSignInAt?: string | null; available: boolean }
export interface PhoneLinkResult { linked: boolean; phoneMasked: string; replaced: boolean; otherSessionsEnded: number }
export const getPhoneStatus = () => shopRequest<PhoneStatus>('/shop/account/phone');
export const linkPhone = (idToken: string, currentPassword: string) =>
  shopRequest<PhoneLinkResult>('/shop/account/phone', { method: 'POST', body: { idToken, currentPassword } });
export const unlinkPhone = (currentPassword: string) =>
  shopRequest<{ linked: false; otherSessionsEnded?: number }>('/shop/account/phone/unlink', { method: 'POST', body: { currentPassword } });

// ---- Google account identity linking -------------------------------------------------------------------
export interface UserIdentities {
  password: { set: boolean };
  phone: { linked: boolean; phoneMasked?: string };
  google: { linked: boolean; emailMasked?: string };
  googleAvailable: boolean;
}
export interface GoogleLinkResult {
  linked: true;
  emailMasked: string;
  replaced: boolean;
  otherSessionsEnded: number;
}
export const getUserIdentities = () => shopRequest<UserIdentities>('/users/me/identities');
export const linkGoogleIdentity = (firebaseIdToken: string, currentPassword?: string) =>
  shopRequest<GoogleLinkResult>('/users/me/identities/google', {
    method: 'POST',
    body: { firebaseIdToken, reauth: { ...(currentPassword ? { currentPassword } : {}) } }
  });
export const unlinkGoogleIdentity = (currentPassword?: string) =>
  shopRequest<{ linked: false; otherSessionsEnded: number }>('/users/me/identities/google/unlink', {
    method: 'POST',
    body: { reauth: { ...(currentPassword ? { currentPassword } : {}) } }
  });
