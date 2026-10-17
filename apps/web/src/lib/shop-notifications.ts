import { shopRequest } from './shop-api';

/** Durable shop notification (server model: docs/REALTIME_NOTIFICATIONS.md). Only safe order metadata, never document data. */
export interface ShopNotification {
  id: string;
  /** Monotonic cursor as a decimal string. */
  seq: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  data: { orderId: string; orderNumber: string };
}
export interface NotificationPage {
  items: ShopNotification[];
  nextCursor: string | null;
  hasMore: boolean;
  latestCursor: string | null;
  unreadCount: number;
}

export const NOTIFICATION_LIST_LIMIT = 20;
/** Newest notifications kept in memory; older ones are fetched on demand. */
export const NOTIFICATION_KEEP = 100;

export function listNotifications(params: { cursor?: string; after?: string; limit?: number } = {}, signal?: AbortSignal) {
  const q = new URLSearchParams();
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.after) q.set('after', params.after);
  if (params.limit) q.set('limit', String(params.limit));
  const qs = q.toString();
  return shopRequest<NotificationPage>(`/shop/notifications${qs ? `?${qs}` : ''}`, signal ? { signal } : {});
}
export const markNotificationRead = (id: string) =>
  shopRequest<{ notification: ShopNotification; unreadCount: number }>(`/shop/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
export const markAllNotificationsRead = () =>
  shopRequest<{ updated: number; unreadCount: number }>('/shop/notifications/read-all', { method: 'POST', body: {} });

/** Runtime guard for pushed data: anything that is not exactly a notification is ignored. */
export function parseNotification(value: unknown): ShopNotification | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const d = v.data as Record<string, unknown> | null | undefined;
  if (typeof v.id !== 'string' || typeof v.seq !== 'string' || !/^\d{1,18}$/.test(v.seq)) return null;
  if (typeof v.createdAt !== 'string' || typeof v.type !== 'string') return null;
  if (!d || typeof d.orderId !== 'string' || typeof d.orderNumber !== 'string') return null;
  return {
    id: v.id, seq: v.seq, type: v.type, createdAt: v.createdAt,
    readAt: typeof v.readAt === 'string' ? v.readAt : null,
    data: { orderId: d.orderId, orderNumber: d.orderNumber }
  };
}

/** Union by id (a read copy wins), newest first by seq, bounded. Pure. */
export function mergeNotifications(base: ShopNotification[], incoming: ShopNotification[]): ShopNotification[] {
  const byId = new Map<string, ShopNotification>();
  for (const n of [...base, ...incoming]) {
    const prev = byId.get(n.id);
    byId.set(n.id, prev && prev.readAt && !n.readAt ? prev : n);
  }
  return [...byId.values()].sort((a, b) => (BigInt(b.seq) > BigInt(a.seq) ? 1 : BigInt(b.seq) < BigInt(a.seq) ? -1 : 0)).slice(0, NOTIFICATION_KEEP);
}
