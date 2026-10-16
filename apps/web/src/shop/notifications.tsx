import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { claimAlert } from '../lib/alert-claim';
import { describeError } from '../lib/shop-api';
import {
  listNotifications, markAllNotificationsRead, markNotificationRead, mergeNotifications, parseNotification,
  NOTIFICATION_LIST_LIMIT, type ShopNotification
} from '../lib/shop-notifications';
import { useToast } from '../ui';
import { isSoundEnabled, playNewOrderChime } from './alert-sound';
import { useRealtime } from './realtime';
import './notifications.css';

export type NotificationsStatus = 'loading' | 'ready' | 'error';

export interface NotificationsApi {
  items: ShopNotification[];
  unread: number;
  status: NotificationsStatus;
  /** Readable reason when `status` is `error`; the rest of the shop UI keeps working. */
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  actionError: string | null;
  loadMore(): void;
  retry(): void;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

const noop = async () => undefined;
const Ctx = createContext<NotificationsApi>({
  items: [], unread: 0, status: 'loading', error: null, hasMore: false, loadingMore: false, actionError: null,
  loadMore: () => undefined, retry: () => undefined, markRead: noop, markAllRead: noop
});
export const useNotifications = () => useContext(Ctx);

const CHANNEL = 'printout-shop-notifications';
const FRESH_MS = 2 * 60_000;
const RECONCILE_MIN_GAP_MS = 5000;

/**
 * Owns the notification inbox for the shop area: loads it, applies live `notification.created` pushes from the shared
 * realtime connection (no second EventSource), reconciles from the cursor API after any gap (reconnect, tab resume), and
 * raises the toast / screen-reader announcement / optional sound exactly once per notification per tab group.
 * The Print queue is refreshed independently by the existing realtime refresh (order.created / notification.created).
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { subscribe, reconnects, state: conn } = useRealtime();
  const toast = useToast(9000);
  const [items, setItems] = useState<ShopNotification[]>([]);
  // Last server-reported unread count (adjusted locally for live pushes and optimistic reads). See `unread` below.
  const [serverUnread, setUnread] = useState(0);
  const [status, setStatus] = useState<NotificationsStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const alive = useRef(true);
  const seen = useRef(new Set<string>());
  const latest = useRef<bigint>(0n);
  const gen = useRef(0);
  const statusRef = useRef<NotificationsStatus>('loading');
  const lastReconcile = useRef(0);
  const cancels = useRef(new Set<() => void>());
  const channel = useRef<BroadcastChannel | null>(null);
  statusRef.current = status;

  const absorb = useCallback((list: ShopNotification[]) => {
    for (const n of list) {
      seen.current.add(n.id);
      const s = BigInt(n.seq);
      if (s > latest.current) latest.current = s;
    }
  }, []);

  const load = useCallback(async () => {
    const my = ++gen.current;
    lastReconcile.current = Date.now();
    try {
      const page = await listNotifications({ limit: NOTIFICATION_LIST_LIMIT });
      if (!alive.current || my !== gen.current) return;
      absorb(page.items);
      setItems((prev) => mergeNotifications(prev, page.items));
      setUnread(page.unreadCount);
      setNextCursor(page.nextCursor);
      setStatus('ready');
      setError(null);
    } catch (e) {
      if (!alive.current || my !== gen.current) return;
      setError(describeError(e));
      setStatus((s) => (s === 'ready' ? s : 'error'));
    }
  }, [absorb]);

  /** Cheap reconcile after a gap: fetch only what is newer than what we have. Falls back to a full reload on a big gap. */
  const catchUp = useCallback(async () => {
    if (statusRef.current !== 'ready') return load();
    const my = ++gen.current;
    lastReconcile.current = Date.now();
    try {
      const page = await listNotifications({ after: latest.current.toString(), limit: 50 });
      if (!alive.current || my !== gen.current) return;
      if (page.hasMore) { gen.current--; return load(); }
      const fresh = page.items.filter((n) => !seen.current.has(n.id));
      absorb(page.items);
      if (fresh.length > 0) {
        setItems((prev) => mergeNotifications(prev, fresh));
        // Missed while disconnected: tell the user once, but never ring for history.
        const unreadFresh = fresh.filter((n) => !n.readAt).length;
        if (unreadFresh > 0) {
          const text = unreadFresh === 1 ? '1 new order arrived while you were away' : `${unreadFresh} new orders arrived while you were away`;
          toast.show(text);
          setAnnouncement(text);
        }
      }
      setUnread(page.unreadCount);
      setError(null);
    } catch (e) {
      if (!alive.current || my !== gen.current) return;
      setError(describeError(e));
    }
  }, [absorb, load, toast]);

  const onLive = useCallback((raw: unknown) => {
    const n = parseNotification(raw);
    if (!n || n.type !== 'order.created' || seen.current.has(n.id)) return; // duplicate delivery: ignore
    absorb([n]);
    setItems((prev) => mergeNotifications(prev, [n]));
    if (!n.readAt) setUnread((u) => u + 1);
    const text = `New order ${n.data.orderNumber}`;
    setAnnouncement(text);
    const fresh = Date.now() - new Date(n.createdAt).getTime() < FRESH_MS;
    // claimAlert may answer synchronously (visible tab) or later (hidden tab), so track the cancel handle defensively.
    let settled = false;
    const handle: { cancel: () => void } = { cancel: () => undefined };
    handle.cancel = claimAlert(n.seq, (mine) => {
      settled = true;
      cancels.current.delete(handle.cancel);
      if (!mine || !alive.current) return;
      toast.show(
        <span className="pb-notiftoast">
          <span>{text}</span>
          <Link className="pb-notiftoast__link" to={`/shop/orders/${encodeURIComponent(n.data.orderId)}`}>View order</Link>
        </span>
      );
      if (fresh && isSoundEnabled()) playNewOrderChime();
    });
    if (!settled) cancels.current.add(handle.cancel);
  }, [absorb, toast]);

  // Initial load + lifecycle.
  useEffect(() => {
    alive.current = true;
    void load();
    const cancelSet = cancels.current;
    return () => {
      alive.current = false;
      gen.current++;
      cancelSet.forEach((c) => c());
      cancelSet.clear();
    };
  }, [load]);

  // Live pushes from the shared realtime connection.
  useEffect(() => subscribe((e) => { if (e.type === 'notification.created') onLive(e.data); }), [subscribe, onLive]);

  // First time the stream is open: close the small window between the initial list fetch and the stream opening.
  const openedOnce = useRef(false);
  useEffect(() => {
    if (conn !== 'live' || openedOnce.current) return;
    openedOnce.current = true;
    void catchUp();
  }, [conn, catchUp]);

  // Reconnected after a gap => reconcile from the database.
  const firstReconnect = useRef(true);
  useEffect(() => {
    if (firstReconnect.current) { firstReconnect.current = false; return; }
    void catchUp();
  }, [reconnects, catchUp]);

  // Tab resumed / window focused: the stream may have been throttled while hidden.
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastReconcile.current < RECONCILE_MIN_GAP_MS) return;
      void catchUp();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => { document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); };
  }, [catchUp]);

  // Keep several tabs' read state in step.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    channel.current = ch;
    ch.onmessage = () => { void load(); };
    return () => { ch.close(); channel.current = null; };
  }, [load]);

  const markRead = useCallback(async (id: string) => {
    const before = items.find((n) => n.id === id);
    if (!before || before.readAt) return;
    setActionError(null);
    const stamp = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: stamp } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      const res = await markNotificationRead(id);
      if (!alive.current) return;
      setUnread(res.unreadCount);
      channel.current?.postMessage('changed');
    } catch (e) {
      if (!alive.current) return;
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: null } : n)));
      setUnread((u) => u + 1);
      setActionError(describeError(e));
    }
  }, [items]);

  const markAllRead = useCallback(async () => {
    setActionError(null);
    const snapshot = items;
    const stamp = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: stamp })));
    setUnread(0);
    try {
      const res = await markAllNotificationsRead();
      if (!alive.current) return;
      setUnread(res.unreadCount);
      channel.current?.postMessage('changed');
    } catch (e) {
      if (!alive.current) return;
      setItems(snapshot);
      void load();
      setActionError(describeError(e));
    }
  }, [items, load]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    listNotifications({ cursor: nextCursor, limit: NOTIFICATION_LIST_LIMIT })
      .then((page) => {
        if (!alive.current) return;
        absorb(page.items);
        setItems((prev) => mergeNotifications(prev, page.items));
        setNextCursor(page.nextCursor);
        setActionError(null);
      })
      .catch((e) => { if (alive.current) setActionError(describeError(e)); })
      .finally(() => { if (alive.current) setLoadingMore(false); });
  }, [nextCursor, loadingMore, absorb]);

  const retry = useCallback(() => { setStatus((s) => (s === 'ready' ? s : 'loading')); void load(); }, [load]);

  // A list response can predate a push that arrived while it was in flight: never show fewer than the unread items we hold.
  const unread = Math.max(serverUnread, items.reduce((n, i) => n + (i.readAt ? 0 : 1), 0));

  const value = useMemo<NotificationsApi>(
    () => ({ items, unread, status, error, hasMore: nextCursor !== null, loadingMore, actionError, loadMore, retry, markRead, markAllRead }),
    [items, unread, status, error, nextCursor, loadingMore, actionError, loadMore, retry, markRead, markAllRead]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Announces every arrival to screen readers in this tab, whichever tab wins the toast. */}
      <div className="pb-sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="notif-announce">{announcement}</div>
      {toast.node}
    </Ctx.Provider>
  );
}
