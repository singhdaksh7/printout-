// Tiny guarded localStorage helper for "recent orders". Tracking tokens are bearer credentials for one order's
// status only; we keep at most a handful on this device. Never throws.
export type RecentOrder = { token: string; orderNumber: string; shopName?: string; slug?: string; at: number };
const KEY = 'printout.recentOrders.v1';
const MAX = 5;

export function getRecentOrders(): RecentOrder[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((o): o is RecentOrder => !!o && typeof o.token === 'string' && typeof o.orderNumber === 'string').slice(0, MAX);
  } catch { return []; }
}

export function rememberOrder(order: Omit<RecentOrder, 'at'>): void {
  try {
    const rest = getRecentOrders().filter((o) => o.token !== order.token);
    localStorage.setItem(KEY, JSON.stringify([{ ...order, at: Date.now() }, ...rest].slice(0, MAX)));
  } catch { /* storage unavailable: feature is optional */ }
}

export function forgetOrders(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
