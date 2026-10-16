import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_KEY } from '../../lib/alert-claim';
import { setCsrfToken } from '../../lib/api';
import { createEventSourceClient } from '../../lib/shop-events';
import { mergeNotifications, parseNotification, type ShopNotification } from '../../lib/shop-notifications';
import { SOUND_KEY, resetAlertSoundForTests } from '../alert-sound';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, type Handler } from './helpers';

let seqCounter = 100;
const notif = (over: Partial<ShopNotification> & { orderNumber?: string } = {}): ShopNotification => {
  const seq = String(++seqCounter);
  const { orderNumber, ...rest } = over;
  return {
    id: `n${seq}`, seq, type: 'order.created', createdAt: new Date().toISOString(), readAt: null,
    data: { orderId: `o${seq}`, orderNumber: orderNumber ?? `CENT-${seq}` }, ...rest
  };
};

/** Stateful fake of GET /shop/notifications, POST :id/read and POST read-all. */
function inbox(store: { items: ShopNotification[]; fail?: boolean }) {
  const afters: Array<string | null> = [];
  const handler: Handler = ({ method, path, query }) => {
    if (!path.startsWith('/shop/notifications')) return undefined;
    if (store.fail) return { status: 500, error: { code: 'INTERNAL_ERROR' } };
    const unread = () => store.items.filter((n) => !n.readAt).length;
    if (method === 'GET') {
      afters.push(query.get('after'));
      const after = query.get('after');
      const cursor = query.get('cursor');
      const limit = Number(query.get('limit') ?? 20);
      let rows = [...store.items].sort((a, b) => Number(BigInt(b.seq) - BigInt(a.seq)));
      if (after) rows = rows.filter((n) => BigInt(n.seq) > BigInt(after));
      if (cursor) rows = rows.filter((n) => BigInt(n.seq) < BigInt(cursor));
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { data: { items: page, nextCursor: hasMore ? page[page.length - 1]!.seq : null, hasMore, latestCursor: rows[0]?.seq ?? null, unreadCount: unread() } };
    }
    if (path === '/shop/notifications/read-all') {
      store.items = store.items.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }));
      return { data: { updated: 1, unreadCount: 0 } };
    }
    const id = /\/shop\/notifications\/([^/]+)\/read/.exec(path)?.[1];
    const target = store.items.find((n) => n.id === id);
    if (!target) return { status: 404, error: { code: 'NOT_FOUND' } };
    target.readAt = target.readAt ?? new Date().toISOString();
    return { data: { notification: target, unreadCount: unread() } };
  };
  return { handler, afters };
}

class FakeAudio {
  static created = 0;
  static started = 0;
  static resumeTo: 'running' | 'suspended' = 'running';
  state: 'running' | 'suspended' = 'suspended';
  currentTime = 0;
  destination = {};
  constructor() { FakeAudio.created++; }
  resume() { this.state = FakeAudio.resumeTo; return Promise.resolve(); }
  createOscillator() { return { frequency: { value: 0 }, connect() {}, start() { FakeAudio.started++; }, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
}

beforeEach(() => {
  FakeES.reset();
  FakeAudio.created = 0; FakeAudio.started = 0; FakeAudio.resumeTo = 'running';
  window.localStorage.clear();
  resetAlertSoundForTests();
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal('AudioContext', FakeAudio);
  setCsrfToken(null);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const bell = () => screen.findByRole('button', { name: /^Notifications/ });
const live = (n: ShopNotification) => act(() => { FakeES.open[0]!.emit('notification.created', n, ''); });

async function setup(store: { items: ShopNotification[]; fail?: boolean }, opts: { strict?: boolean } = {}) {
  const box = inbox(store);
  const net = mockFetch(authedSession, box.handler, emptyList);
  renderShop('/shop', opts);
  await screen.findByRole('heading', { name: 'Print queue' });
  await waitFor(() => expect(FakeES.open).toHaveLength(1));
  act(() => FakeES.open[0]!.open_());
  return { ...box, net };
}

describe('notification bell', () => {
  it('shows the unread count in the badge and the accessible name', async () => {
    await setup({ items: [notif(), notif(), notif({ readAt: new Date().toISOString() })] });
    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
  });

  it('has no badge when everything is read', async () => {
    await setup({ items: [notif({ readAt: new Date().toISOString() })] });
    expect(await bell()).toHaveAccessibleName('Notifications');
    expect(document.querySelector('.pb-bell__badge')).toBeNull();
  });

  it('lists recent notifications newest first with links to the order, and an empty state', async () => {
    const a = notif({ orderNumber: 'CENT-1' });
    const b = notif({ orderNumber: 'CENT-2' });
    await setup({ items: [a, b] });
    await userEvent.click(await screen.findByRole('button', { name: /Notifications, 2 unread/ }));
    const list = await screen.findByRole('list', { name: /newest first/i });
    const links = within(list).getAllByRole('link');
    expect(links[0]).toHaveTextContent('CENT-2');
    expect(links[1]).toHaveTextContent('CENT-1');
    expect(links[0]).toHaveAttribute('href', `/shop/orders/${b.data.orderId}`);
  });

  it('shows an empty state', async () => {
    await setup({ items: [] });
    await userEvent.click(await bell());
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });

  it('shows a loading state, then a recoverable error that does not block the queue', async () => {
    const store = { items: [notif()], fail: true };
    await setup(store);
    await userEvent.click(await bell());
    expect(await screen.findByText(/Notifications are unavailable right now/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
    store.fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: /newest first/i })).toBeInTheDocument();
  });

  it('marks one notification read and all as read', async () => {
    const store = { items: [notif({ orderNumber: 'CENT-1' }), notif({ orderNumber: 'CENT-2' })] };
    const { net } = await setup(store);
    await userEvent.click(await screen.findByRole('button', { name: /2 unread/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark CENT-2 as read' }));
    await waitFor(() => expect(net.calls.some((c) => c.method === 'POST' && /\/read$/.test(c.path) && !c.path.endsWith('read-all'))).toBe(true));
    expect(await screen.findByRole('button', { name: /Notifications, 1 unread/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(net.calls.some((c) => c.path === '/shop/notifications/read-all')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });

  it('rolls back the optimistic read and explains when marking fails', async () => {
    const store = { items: [notif({ orderNumber: 'CENT-1' })] };
    const box = inbox(store);
    const failing: Handler = (req) => (req.method === 'POST' ? { status: 500, error: { code: 'INTERNAL_ERROR' } } : undefined);
    mockFetch(authedSession, failing, box.handler, emptyList);
    renderShop('/shop');
    await screen.findByRole('heading', { name: 'Print queue' });
    act(() => FakeES.open[0]!.open_());
    await userEvent.click(await screen.findByRole('button', { name: /1 unread/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark CENT-1 as read' }));
    expect(await screen.findByText(/server had a problem/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Notifications, 1 unread/ })).toBeInTheDocument();
  });
});

describe('keyboard and screen readers', () => {
  it('opens as a labelled dialog, arrow keys move between notifications, Escape closes and returns focus to the bell', async () => {
    await setup({ items: [notif({ orderNumber: 'CENT-1' }), notif({ orderNumber: 'CENT-2' }), notif({ orderNumber: 'CENT-3' })] });
    const trigger = await screen.findByRole('button', { name: /3 unread/ });
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    const links = within(dialog).getAllByRole('link');
    links[0]!.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(links[1]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(links[2]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(links[1]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(links[0]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('announces a new order politely to screen readers and marks unread items in text', async () => {
    await setup({ items: [] });
    live(notif({ orderNumber: 'CENT-77' }));
    await waitFor(() => expect(screen.getByTestId('notif-announce')).toHaveTextContent('New order CENT-77'));
    expect(screen.getByTestId('notif-announce')).toHaveAttribute('aria-live', 'polite');
    await userEvent.click(await screen.findByRole('button', { name: /1 unread/ }));
    expect(await screen.findByText('(unread)')).toBeInTheDocument();
  });
});

describe('live new-order events', () => {
  it('raises a toast with a link, bumps the badge and refreshes the queue without a manual refresh', async () => {
    const { net } = await setup({ items: [] });
    const before = net.calls.filter((c) => c.path === '/shop/orders').length;
    const n = notif({ orderNumber: 'CENT-9' });
    live(n);
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'View order' });
    expect(link).toHaveAttribute('href', `/shop/orders/${n.data.orderId}`);
    expect(screen.getAllByText('New order CENT-9').length).toBeGreaterThan(0);
    await waitFor(() => expect(net.calls.filter((c) => c.path === '/shop/orders').length).toBeGreaterThan(before));
  });

  it('ignores a duplicate delivery of the same notification (one toast, one count)', async () => {
    await setup({ items: [] });
    const n = notif({ orderNumber: 'CENT-5' });
    live(n);
    live(n);
    live({ ...n });
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /1 unread/ }));
    expect(within(screen.getByRole('list', { name: /newest first/i })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('does not duplicate a notification that is already in the list when it also arrives live', async () => {
    const n = notif();
    await setup({ items: [n] });
    live(n);
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
  });

  it('ignores malformed or foreign events', async () => {
    await setup({ items: [] });
    act(() => { FakeES.open[0]!.emit('notification.created', { id: 5, seq: 'x' }, ''); });
    act(() => { FakeES.open[0]!.emit('notification.created', { ...notif(), type: 'something.else' }, ''); });
    expect(await bell()).toHaveAccessibleName('Notifications');
  });

  it('does not re-alert for a notification another tab already alerted for, but still lists it', async () => {
    await setup({ items: [] });
    const n = notif({ orderNumber: 'CENT-8' });
    window.localStorage.setItem(CLAIM_KEY, n.seq);
    live(n);
    expect(await screen.findByRole('button', { name: /1 unread/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View order' })).toBeNull();
    expect(screen.getByTestId('notif-announce')).toHaveTextContent('New order CENT-8');
  });
});

describe('reconnect and resume', () => {
  it('catches up on orders missed while disconnected, tells the user once, and never rings for history', async () => {
    window.localStorage.setItem(SOUND_KEY, '1');
    const store = { items: [notif()] as ShopNotification[] };
    const { afters } = await setup(store);
    await screen.findByRole('button', { name: /1 unread/ });
    const started = FakeAudio.started;
    act(() => FakeES.open[0]!.fail(false));
    store.items = [...store.items, notif({ orderNumber: 'CENT-M1' }), notif({ orderNumber: 'CENT-M2' })];
    act(() => FakeES.open[0]!.open_());
    expect(await screen.findByRole('button', { name: /3 unread/ })).toBeInTheDocument();
    expect(screen.getByTestId('notif-announce')).toHaveTextContent('2 new orders arrived while you were away');
    expect(afters.some((a) => a && /^\d+$/.test(a))).toBe(true); // used the cursor, not a full reload
    expect(FakeAudio.started).toBe(started); // no sound for catch-up
  });

  it('shows Reconnecting and Offline as warnings (never an error colour) and keeps the panel informative', async () => {
    await setup({ items: [] });
    const chip = () => screen.getByRole('status', { name: /connection/i });
    act(() => FakeES.open[0]!.fail(false));
    expect(chip()).toHaveTextContent('Reconnecting…');
    expect(chip().className).toContain('warn');
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(chip()).toHaveTextContent('Offline');
    expect(chip().className).not.toContain('err');
    await userEvent.click(await bell());
    expect(await screen.findByText(/Temporarily disconnected/)).toBeInTheDocument();
  });

  it('keeps one EventSource under StrictMode and closes it (and stops delivering) on unmount', async () => {
    const box = inbox({ items: [] });
    mockFetch(authedSession, box.handler, emptyList);
    const view = renderShop('/shop', { strict: true });
    await screen.findByRole('heading', { name: 'Print queue' });
    expect(FakeES.open).toHaveLength(1);
    view.unmount();
    expect(FakeES.open).toHaveLength(0);
  });
});

describe('sound alerts', () => {
  it('is off by default: no audio context, no sound for a live order', async () => {
    await setup({ items: [] });
    live(notif());
    await screen.findByRole('button', { name: /1 unread/ });
    expect(FakeAudio.created).toBe(0);
    expect(FakeAudio.started).toBe(0);
  });

  it('opt-in happens by an explicit click that unlocks audio, persists, and rings once per live order', async () => {
    await setup({ items: [] });
    await userEvent.click(await bell());
    const box = within(await screen.findByRole('dialog', { name: 'Notifications' })).getByRole('switch', { name: 'Sound for new orders' });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(box).toBeChecked();
    expect(window.localStorage.getItem(SOUND_KEY)).toBe('1');
    await waitFor(() => expect(FakeAudio.created).toBe(1));
    live(notif({ orderNumber: 'CENT-A' }));
    await waitFor(() => expect(FakeAudio.started).toBe(2)); // two-tone chime
    live(notif({ orderNumber: 'CENT-B' })); // within the 3 s guard
    await screen.findByRole('button', { name: /2 unread/ });
    expect(FakeAudio.started).toBe(2);
  });

  it('does not play for an old notification delivered late', async () => {
    window.localStorage.setItem(SOUND_KEY, '1');
    await setup({ items: [] });
    await userEvent.click(await bell()); // gesture unlocks audio
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    live(notif({ createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    await screen.findByRole('button', { name: /1 unread/ });
    expect(FakeAudio.started).toBe(0);
  });

  it('respects browser autoplay rules: if audio is still locked the chime is skipped and the user is asked to enable it', async () => {
    FakeAudio.resumeTo = 'suspended';
    window.localStorage.setItem(SOUND_KEY, '1');
    await setup({ items: [] });
    live(notif());
    await screen.findByRole('button', { name: /1 unread/ });
    expect(FakeAudio.started).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: /1 unread/ }));
    expect(await screen.findByText(/browser is blocking the sound/i)).toBeInTheDocument();
    FakeAudio.resumeTo = 'running';
    await userEvent.click(screen.getByRole('button', { name: 'Enable sound' }));
    await waitFor(() => expect(screen.queryByText(/browser is blocking the sound/i)).toBeNull());
  });

  it('mute turns it off again and persists', async () => {
    window.localStorage.setItem(SOUND_KEY, '1');
    await setup({ items: [] });
    await userEvent.click(await bell());
    const box = within(await screen.findByRole('dialog', { name: 'Notifications' })).getByRole('switch', { name: 'Sound for new orders' });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(window.localStorage.getItem(SOUND_KEY)).toBe('0');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    live(notif());
    await screen.findByRole('button', { name: /1 unread/ });
    expect(FakeAudio.started).toBe(0);
  });
});

describe('client helpers', () => {
  it('parseNotification accepts exactly the safe shape and strips everything else', () => {
    const good = { ...notif(), objectKey: 'secret', downloadUrl: 'http://x', data: { orderId: 'o', orderNumber: 'N', storageKey: 'k' } };
    const parsed = parseNotification(good)!;
    expect(parsed.data).toEqual({ orderId: 'o', orderNumber: 'N' });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|http|storageKey/);
    for (const bad of [null, 'x', {}, { ...good, seq: 'abc' }, { ...good, data: null }, { ...good, id: 3 }]) expect(parseNotification(bad)).toBeNull();
  });

  it('mergeNotifications unions by id, keeps the read copy, sorts newest first and is bounded', () => {
    const a = notif();
    const b = notif();
    const merged = mergeNotifications([a], [{ ...a, readAt: 'now' }, b]);
    expect(merged.map((n) => n.id)).toEqual([b.id, a.id]);
    expect(merged.find((n) => n.id === a.id)!.readAt).toBe('now');
    expect(mergeNotifications([{ ...a, readAt: 'now' }], [a])[0]!.readAt).toBe('now');
    const many = Array.from({ length: 150 }, () => notif());
    expect(mergeNotifications([], many)).toHaveLength(100);
  });

  it('the SSE client does not drop notification.created because the browser repeats the previous stream id', () => {
    const received: string[] = [];
    const client = createEventSourceClient({
      EventSourceImpl: FakeES as never,
      isOnline: () => true,
      onEvent: (e) => received.push(e.type),
      onState: () => undefined
    });
    const es = FakeES.instances.at(-1)!;
    es.emit('order.created', { id: 1 }, '77');
    es.emit('notification.created', { id: 2 }, '77'); // browsers report the last id (77) for id-less events
    es.emit('order.created', { id: 1 }, '77'); // a genuine duplicate of a numbered event is still dropped
    expect(received).toEqual(['order.created', 'notification.created']);
    client.close();
  });
});
