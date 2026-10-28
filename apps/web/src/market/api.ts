import { api, ApiError, setCsrfToken } from '../lib/api';

/** Customer marketplace API client (server routes: docs/schema-v2/PHASE1..5_CONTRACT.md). Prices are per SHEET, in integer paise. */
export type Rate = { paperSize: string; colourMode: 'bw' | 'colour'; sides: 'single' | 'duplex'; pricePerSheetPaise: number };
export type ShopCard = {
  id: string; shopName: string; phoneNumber: string | null; addressLine1: string | null; city: string | null; state: string | null; pincode: string | null;
  isOpen: boolean; acceptsOrders: boolean; availability: { state: 'open' | 'closed' | 'unknown'; nextOpenAt: string | null; closesAt: string | null; orderingBlocked: boolean };
  rates: Rate[]; paperSizes: string[]; paperTypes: string[]; images: Array<{ id: string; url: string; sortOrder: number }>;
  acceptedPaymentMethods: Array<'cash' | 'upi'>; upiId: string | null; ratingAvg: number | null; ratingCount: number; distanceKm?: number;
};
export type Page<T> = { items: T[]; page: number; limit: number; total: number };
export type Review = { id: string; rating: number; comment: string | null; customerName: string; createdAt: string };
export type PaymentView = { method: 'cash' | 'upi' | null; status: 'unpaid' | 'pendingVerification' | 'paid' | 'refunded'; upiTxnRef: string | null; upiId: string | null };
export type OrderStatus = 'NEW' | 'ACCEPTED' | 'PRINTING' | 'PRINTED' | 'READY' | 'COLLECTED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
export type CustomerOrder = {
  id: string; orderNumber: string; shopId: string; shopName: string; status: OrderStatus; totalPaise: number; currency: string; fileName: string; pages: number | null;
  note: string | null; isReviewed: boolean; payment: PaymentView; createdAt: string; updatedAt: string; fileDeletedAt: string | null;
  printOptions: { colourMode?: string; sides?: string; copies?: number } | null;
  statusHistory?: Array<{ status: string; by: 'customer' | 'shop' | 'system'; reason: string | null; createdAt: string }>;
};
export type AppNotification = { id: string; type: 'orderStatus' | 'payment'; title: string; body: string; orderId: string | null; readAt: string | null; createdAt: string };
export type Quote = { quoteId: string; shopId: string; totalPaise: number; totalSheets?: number; selectedPageCount?: number; expiresAt: string };
export type PrintOptions = { paperSize: 'A4'; colourMode: 'bw' | 'colour'; sides: 'single' | 'duplex'; copies: number; pageSelection: { mode: 'all' } };

export type Profile = { user: { id: string | null; role: 'customer' | 'shop' | 'admin' | null; name: string | null; email: string | null }; nextStep: string; csrfToken?: string; session?: { transport: string } | null };

export const customerGoogleSession = async (idToken: string): Promise<Profile> => {
  const p = await api<Profile>('/auth/customer/google/session', { method: 'POST', body: { idToken } });
  setCsrfToken(p.csrfToken ?? null);
  return p;
};
export const registerCustomer = async (name: string): Promise<Profile> => {
  const p = await api<Profile>('/customers/onboarding', { method: 'POST', body: { name, client: 'web' } });
  setCsrfToken(p.csrfToken ?? null);
  return p;
};
/** Current customer profile, or null when there is no customer session. */
export async function myProfile(): Promise<Profile | null> {
  try {
    const p = await api<Profile & { csrfToken?: string }>('/customers/me');
    return p;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}
export const logout = async () => { try { await api<void>('/auth/logout', { method: 'POST', body: {} }); } finally { setCsrfToken(null); } };
/** The web session CSRF token is only issued at sign-in; after a reload it is refreshed from the session probe. */
export const refreshCsrf = async () => {
  const s = await api<{ csrfToken?: string }>('/auth/session');
  setCsrfToken(s.csrfToken ?? null);
};

export const nearbyShops = (q: { lat: number; lng: number; radiusKm: number; printingType?: 'colored' | 'blackWhite' }) =>
  api<Page<ShopCard>>(`/customer/shops/nearby?lat=${q.lat}&lng=${q.lng}&radiusKm=${q.radiusKm}${q.printingType ? `&printingType=${q.printingType}` : ''}`);
export const shopDetail = (id: string) => api<ShopCard & { location?: { latitude: number; longitude: number } }>(`/customer/shops/${encodeURIComponent(id)}`);
export const shopReviews = (id: string, page = 1) => api<Page<Review> & { ratingAvg: number | null; ratingCount: number }>(`/customer/shops/${encodeURIComponent(id)}/reviews?page=${page}&limit=10`);

export type Upload = { uploadId: string; uploadUrl: string; requiredHeaders?: Record<string, string>; completePath: string; limits?: { maxBytes: number } };
export const startUpload = (shopId: string, file: File) => api<Upload>('/customer/uploads', { method: 'POST', body: { shopId, fileName: file.name, byteSize: file.size, declaredMimeType: file.type } });
export async function putFile(up: Upload, file: File): Promise<void> {
  const res = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'content-type': file.type, ...(up.requiredHeaders ?? {}) }, body: file });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiError(res.status, j?.error?.code ?? 'UPLOAD_FAILED', j?.error?.message ?? 'The upload failed. Try again.');
  }
}
export const completeUpload = (up: Upload) => api<{ documentId: string; pageCount: number | null }>(up.completePath, { method: 'POST', body: {} });
export const createQuote = (shopId: string, documentId: string, printOptions: PrintOptions) => api<Quote>('/customer/quotes', { method: 'POST', body: { shopId, documentId, printOptions } });
export const placeOrder = (quoteId: string, paymentMethod: 'cash' | 'upi', note: string, clientRequestId: string) =>
  api<CustomerOrder>('/customer/orders', { method: 'POST', body: { quoteId, paymentMethod, clientRequestId, ...(note.trim() ? { note: note.trim() } : {}) } });

export const myOrders = (page = 1) => api<Page<CustomerOrder>>(`/customer/orders?page=${page}&limit=20`);
export const myOrder = (id: string) => api<CustomerOrder>(`/customer/orders/${encodeURIComponent(id)}`);
export const cancelOrder = (id: string, cancelReason?: string) => api<CustomerOrder>(`/customer/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: cancelReason ? { cancelReason } : {} });
export const submitUtr = (id: string, upiTxnRef: string) => api<CustomerOrder>(`/customer/orders/${encodeURIComponent(id)}/payment`, { method: 'POST', body: { upiTxnRef } });
export const reviewOrder = (orderId: string, rating: number, comment: string) => api<Review>('/customer/reviews', { method: 'POST', body: { orderId, rating, ...(comment.trim() ? { comment } : {}) } });

export const notifications = (page = 1) => api<Page<AppNotification> & { unreadCount: number }>(`/customer/notifications?page=${page}&limit=20`);
export const markRead = (id: string) => api<void>(`/customer/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
export const markAllRead = () => api<{ updated: number }>('/customer/notifications/read-all', { method: 'POST', body: {} });

/** Customer-facing wording. REJECTED / CANCELLED / EXPIRED are final. */
export const STATUS_TEXT: Record<OrderStatus, { label: string; tone: 'neutral' | 'info' | 'orange' | 'ok' | 'warn' | 'err'; done: boolean }> = {
  NEW: { label: 'Waiting for the shop', tone: 'info', done: false },
  ACCEPTED: { label: 'Accepted', tone: 'info', done: false },
  PRINTING: { label: 'Printing', tone: 'orange', done: false },
  PRINTED: { label: 'Printed', tone: 'ok', done: false },
  READY: { label: 'Ready for pickup', tone: 'ok', done: false },
  COLLECTED: { label: 'Completed', tone: 'ok', done: true },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', done: true },
  REJECTED: { label: 'Rejected by the shop', tone: 'err', done: true },
  EXPIRED: { label: 'Expired', tone: 'warn', done: true }
};
export const PAYMENT_TEXT = { unpaid: 'Not paid yet', pendingVerification: 'Waiting for the shop to confirm', paid: 'Paid', refunded: 'Refunded' } as const;

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'NETWORK_ERROR': return 'Cannot reach the server. Check your connection and try again.';
      case 'RATE_LIMITED': return 'Too many attempts. Please wait a minute and try again.';
      case 'SHOP_CLOSED': return 'This shop is closed right now. Try again when it opens.';
      case 'SHOP_UNAVAILABLE': case 'SHOP_NOT_FOUND': return 'This shop is not taking orders right now.';
      case 'FILE_TOO_LARGE': return 'That file is too large (50 MB maximum).';
      case 'DUPLICATE_UTR': return 'That payment reference was already used. Check the number and try again.';
      case 'PAYMENT_METHOD_NOT_ACCEPTED': return 'This shop does not accept that payment method.';
      case 'PAYMENT_RECORDED': return 'A payment is recorded for this order. Contact the shop before cancelling.';
      case 'REVIEW_EXISTS': return 'You already reviewed this order.';
      case 'ORDER_NOT_COMPLETED': return 'You can review an order once printing has started.';
      case 'INVALID_STATUS_TRANSITION': return 'This order can no longer be cancelled.';
      case 'CUSTOMER_SIGNUP_DISABLED': return 'Customer sign-up is not open yet.';
      case 'ACCOUNT_BLOCKED': return 'This account is blocked. Contact support.';
      case 'GOOGLE_LOGIN_UNAVAILABLE': return 'Google sign-in is unavailable right now.';
    }
    if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
    return e.message || 'Something went wrong. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}
