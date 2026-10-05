import { shopRequest } from './shop-api';

export type ShopStatus = 'ACTIVE' | 'SUSPENDED';
export type SubStatus = 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
export const SUB_STATUSES: SubStatus[] = ['ACTIVE', 'SUSPENDED', 'CANCELLED'];

export interface PlanRef { id: string; name: string; pricePaise: number }
export interface Subscription { id: string; shopId: string; status: SubStatus; renewsAt: string | null; updatedAt: string; plan: PlanRef }
export interface AdminShop {
  id: string; slug: string; displayName: string; address: string | null; status: ShopStatus; acceptsOrders: boolean;
  createdAt: string; updatedAt: string; subscription?: Subscription | null;
  owner?: { displayName: string; email: string } | null; orderCount?: number; lastOrderAt?: string | null;
}
/** Operational metadata only: the API never returns document content, storage keys, URLs or tracking tokens. */
export interface AdminOrder {
  id: string; shopId: string; shopSlug: string; shopName: string; orderNumber: string; status: string;
  customerDisplayNameOrReference: string | null; totalPaise: number; currency: string; createdAt: string; updatedAt: string;
  fileName: string; mimeType: string | null; pageCount: number | null; selectedPageCount: number | null; paperSize: string | null;
  colourMode: string | null; sides: string | null; copies: number | null; pageSelection: unknown;
  documentStatus: string; printedAt: string | null; deleteAfter: string | null; deletedAt: string | null;
}
export interface AdminPricingRule { id: string; paperSize: string; colourMode: string; sides: string; pricePerSheetPaise: number; active: boolean }
export interface Dashboard {
  timezone: string; totalShops: number; shopsByStatus: Record<string, number>; activeSubscriptions: number;
  subscriptionsByStatus: Record<string, number>; ordersToday: number;
  totalOrders: number; ordersByStatus: Record<string, number>; totalPages: number;
  recentShops: AdminShop[]; recentOrders: AdminOrder[];
}
export interface ShopDetail {
  shop: AdminShop;
  owners: { id: string; email: string; displayName: string; role: string }[];
  subscription: Subscription | null;
  usage: { orderCount: number; ordersLast30Days: number; pricingRuleCount: number; lastOrderAt: string | null };
  ordersByStatus: Record<string, number>; pricingRules: AdminPricingRule[]; recentOrders: AdminOrder[];
}
export interface Plan { id: string; name: string; pricePaise: number; active: boolean; updatedAt?: string }
export interface AuditEntry {
  id: string; shopId: string | null; actorUserId: string | null; action: string; targetType: string | null; targetId: string | null;
  metadata: unknown; createdAt: string;
}
export interface Page<T> { items: T[]; nextCursor?: string | undefined }

export interface CreateShopInput {
  slug: string; displayName: string; address?: string | null; planId?: string;
  owner: { email: string; displayName: string; password: string };
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const getDashboard = (signal?: AbortSignal) => shopRequest<Dashboard>('/admin/dashboard', { signal: signal as AbortSignal });
export const listShops = (p: { status?: ShopStatus | ''; q?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
  shopRequest<Page<AdminShop>>(`/admin/shops${qs(p)}`, { signal: signal as AbortSignal });
export const createShop = (body: CreateShopInput) =>
  shopRequest<{ shop: AdminShop; owner: { id: string; email: string; displayName: string } }>('/admin/shops', { method: 'POST', body });
export const getShop = (id: string, signal?: AbortSignal) => shopRequest<ShopDetail>(`/admin/shops/${encodeURIComponent(id)}`, { signal: signal as AbortSignal });
export const updateShop = (id: string, body: { status?: ShopStatus; acceptsOrders?: boolean; displayName?: string }) =>
  shopRequest<{ shop: AdminShop }>(`/admin/shops/${encodeURIComponent(id)}`, { method: 'PUT', body });
/** `shopId` identifies the subscription (one per shop). */
export const updateSubscription = (shopId: string, body: { status?: SubStatus; planId?: string; renewsAt?: string | null }) =>
  shopRequest<Subscription>(`/admin/subscriptions/${encodeURIComponent(shopId)}`, { method: 'PUT', body });
export const listOrders = (p: { shopId?: string; status?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
  shopRequest<Page<AdminOrder>>(`/admin/orders${qs(p)}`, { signal: signal as AbortSignal });
export type SubscriptionRow = Subscription & { shop: { slug: string; displayName: string; status: ShopStatus } };
export const listSubscriptions = (p: { status?: SubStatus | ''; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
  shopRequest<Page<SubscriptionRow>>(`/admin/subscriptions${qs(p)}`, { signal: signal as AbortSignal });
export const listPlans = (signal?: AbortSignal) => shopRequest<Plan[]>('/admin/plans', { signal: signal as AbortSignal });
export const updatePlan = (id: string, body: { name?: string; pricePaise?: number; active?: boolean }) =>
  shopRequest<Plan>(`/admin/plans/${encodeURIComponent(id)}`, { method: 'PUT', body });
export const createPlan = (body: { name: string; pricePaise: number; active: boolean }) =>
  shopRequest<Plan>('/admin/plans', { method: 'POST', body });
export const listAuditLogs = (p: { shopId?: string; action?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
  shopRequest<Page<AuditEntry>>(`/admin/audit-logs${qs(p)}`, { signal: signal as AbortSignal });

// ---- pure helpers (tested) ---------------------------------------------------------------------------
/** Client hint only; the server is authoritative (also rejects reserved slugs). */
export function slugHint(slug: string): string | null {
  if (!slug) return 'Slug is required.';
  if (slug.length < 3) return 'At least 3 characters.';
  if (slug.length > 60) return 'At most 60 characters.';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return 'Lowercase letters, digits and single hyphens only.';
  return null;
}
/** Rupees text ("99", "99.5", "99.50") -> integer paise, or null if invalid. Avoids float math. */
export function rupeesToPaise(input: string): number | null {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}
export const paiseToRupees = (paise: number) => (paise / 100).toFixed(2);
export const inr = (paise: number) => `₹${paiseToRupees(paise)}`;
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
}
