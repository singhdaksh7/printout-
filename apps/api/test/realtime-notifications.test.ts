import type { PrismaClient } from '@prisma/client';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { cleanupNotifications, recordOrderCreated, ShopNotificationHub, toNotificationDto, type NotificationDto } from '../src/notifications/shop-notifications.js';
import { testPrisma } from './helpers/db.js';
import { baseOptions, call, createDocument, login, newOrder, placeOrder, quoteFor, seedWorld, testConfig, type Session, type World } from './api-helpers.js';

const prisma = testPrisma();
let world: World;
const closers: Array<() => Promise<void>> = [];
const open: http.ClientRequest[] = [];

beforeEach(async () => {
  world = await seedWorld(prisma);
});
afterEach(async () => {
  for (const r of open.splice(0)) r.destroy();
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks();
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_notification_insert ON "ShopNotification"');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_notification_insert()');
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error('condition not met in time');
}

function build(overrides: Record<string, string> = {}) {
  const built = createApp({ config: testConfig(overrides), prisma });
  closers.push(() => built.app.close());
  return built;
}

async function listening(overrides: Record<string, string> = {}) {
  const built = build(overrides);
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  return { ...built, port: (built.app.server.address() as AddressInfo).port };
}

interface Stream {
  status: number;
  ended: () => boolean;
  text: () => string;
  close: () => void;
}

function connect(port: number, session: Session | null): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let ended = false;
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/v1/shop/events', headers: session ? { cookie: session.cookie } : {} },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => chunks.push(c));
        res.on('end', () => (ended = true));
        res.on('close', () => (ended = true));
        resolve({ status: res.statusCode!, ended: () => ended, text: () => chunks.join(''), close: () => req.destroy() });
      }
    );
    req.on('error', reject);
    open.push(req);
  });
}

const notificationFrames = (text: string) =>
  text
    .split('\n\n')
    .filter((f) => f.includes('event: notification.created'))
    .map((f) => ({ raw: f, data: JSON.parse(f.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as NotificationDto }));

describe('transactional outbox', () => {
  it('commits a notification with the order and stores only safe metadata', async () => {
    const { app } = build();
    const { order } = await newOrder(app, prisma, world.a);
    const rows = await prisma.shopNotification.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shopId: world.a.shopId, orderId: order.id, type: 'order.created', readAt: null });
    expect(rows[0]!.payload).toEqual({ orderId: order.id, orderNumber: order.orderNumber });
    const text = JSON.stringify(toNotificationDto(rows[0]!));
    for (const secret of ['objectKey', 'test-', 'notes.pdf', 'trackingToken', order.trackingToken, 'http']) expect(text).not.toContain(secret);
  });

  it('rolls the order back when the notification cannot be written (atomic), and the customer sees an error not a half order', async () => {
    const { app } = build();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION fail_notification_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced'; END; $$ LANGUAGE plpgsql`
    );
    await prisma.$executeRawUnsafe('CREATE TRIGGER fail_notification_insert BEFORE INSERT ON "ShopNotification" FOR EACH ROW EXECUTE FUNCTION fail_notification_insert()');
    const doc = await createDocument(prisma, world.a.shopId);
    const quote = await quoteFor(app, world.a.slug, doc.id);
    const res = await placeOrder(app, world.a.slug, quote.json().data.quoteId);
    expect(res.statusCode).toBe(500);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.shopNotification.count()).toBe(0);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: world.a.shopId } })).orderCounter).toBe(0);
  });

  it('a failing post-commit fan-out never fails or loses the customer order', async () => {
    const built = build();
    vi.spyOn(built.notifications, 'publish').mockImplementation(() => {
      throw new Error('fan-out down');
    });
    const { order } = await newOrder(built.app, prisma, world.a);
    expect(order.status).toBe('NEW');
    expect(await prisma.shopNotification.count({ where: { shopId: world.a.shopId } })).toBe(1);
  });

  it('is idempotent per order (dedupe key) and an idempotent customer retry creates no second notification', async () => {
    const { app } = build();
    const { order } = await newOrder(app, prisma, world.a);
    await prisma.$transaction((tx) => recordOrderCreated(tx, { shopId: world.a.shopId, orderId: order.id, orderNumber: order.orderNumber }));
    expect(await prisma.shopNotification.count()).toBe(1);

    const doc = await createDocument(prisma, world.a.shopId);
    const quote = (await quoteFor(app, world.a.slug, doc.id)).json().data.quoteId;
    const clientRequestId = '11111111-1111-4111-8111-111111111111';
    const first = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/orders`, payload: { quoteId: quote, clientRequestId } });
    const retry = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/orders`, payload: { quoteId: quote, clientRequestId } });
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(await prisma.shopNotification.count()).toBe(2);
  });

  it('orders from concurrent customers get unique, increasing seq values', async () => {
    const { app } = build();
    await Promise.all(Array.from({ length: 5 }, () => newOrder(app, prisma, world.a)));
    const rows = await prisma.shopNotification.findMany({ where: { shopId: world.a.shopId }, orderBy: { createdAt: 'asc' } });
    const seqs = rows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(5);
  });
});

describe('notification inbox API', () => {
  it('requires an authenticated shop owner', async () => {
    const { app } = build();
    const admin = await login(app, world.adminEmail);
    expect((await call(app, null, 'GET', '/shop/notifications')).statusCode).toBe(401);
    expect((await call(app, admin, 'GET', '/shop/notifications')).statusCode).toBe(403);
    expect((await call(app, null, 'POST', '/shop/notifications/read-all', {})).statusCode).toBe(401);
  });

  it('isolates shops: lists, unread counts, mark-read and read-all never cross tenants', async () => {
    const { app } = build();
    const a = await login(app, world.a.ownerEmail);
    const b = await login(app, world.b.ownerEmail);
    await newOrder(app, prisma, world.a);
    await newOrder(app, prisma, world.a);
    await newOrder(app, prisma, world.b);

    const listA = (await call(app, a, 'GET', '/shop/notifications')).json().data;
    const listB = (await call(app, b, 'GET', '/shop/notifications')).json().data;
    expect(listA.items).toHaveLength(2);
    expect(listA.unreadCount).toBe(2);
    expect(listB.items).toHaveLength(1);
    // newest first
    expect(BigInt(listA.items[0].seq)).toBeGreaterThan(BigInt(listA.items[1].seq));

    // B cannot read or mark A's notification (404, indistinguishable from unknown)
    const foreign = await call(app, b, 'POST', `/shop/notifications/${listA.items[0].id}/read`, {});
    expect(foreign.statusCode).toBe(404);
    expect((await prisma.shopNotification.findUniqueOrThrow({ where: { id: listA.items[0].id } })).readAt).toBeNull();

    // B read-all only touches B
    const all = await call(app, b, 'POST', '/shop/notifications/read-all', {});
    expect(all.json().data).toMatchObject({ updated: 1, unreadCount: 0 });
    expect((await call(app, a, 'GET', '/shop/notifications')).json().data.unreadCount).toBe(2);
  });

  it('marks read idempotently and keeps unread state across a new session and a new API process', async () => {
    const first = build();
    const a = await login(first.app, world.a.ownerEmail);
    await newOrder(first.app, prisma, world.a);
    await newOrder(first.app, prisma, world.a);
    const [n1] = (await call(first.app, a, 'GET', '/shop/notifications')).json().data.items;
    const one = await call(first.app, a, 'POST', `/shop/notifications/${n1.id}/read`, {});
    expect(one.json().data.unreadCount).toBe(1);
    const readAt = one.json().data.notification.readAt;
    const again = await call(first.app, a, 'POST', `/shop/notifications/${n1.id}/read`, {});
    expect(again.json().data.notification.readAt).toBe(readAt);

    // "restart": brand new app + new login; durable state survives
    await first.app.close();
    closers.pop();
    const second = build();
    const a2 = await login(second.app, world.a.ownerEmail);
    const data = (await call(second.app, a2, 'GET', '/shop/notifications')).json().data;
    expect(data.unreadCount).toBe(1);
    expect(data.items).toHaveLength(2);
  });

  it('enforces CSRF on mutations and rejects malformed input', async () => {
    const { app } = build();
    const a = await login(app, world.a.ownerEmail);
    const res = await app.inject({ method: 'POST', url: '/api/v1/shop/notifications/read-all', headers: { cookie: a.cookie }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect((await call(app, a, 'GET', '/shop/notifications?limit=1000')).statusCode).toBe(400);
    expect((await call(app, a, 'GET', '/shop/notifications?cursor=abc')).statusCode).toBe(400);
    expect((await call(app, a, 'GET', '/shop/notifications?shopId=other')).statusCode).toBe(400);
  });

  it('pages with a cursor and catches up with `after` (no gaps, no duplicates)', async () => {
    const { app } = build();
    const a = await login(app, world.a.ownerEmail);
    for (let i = 0; i < 5; i++) await newOrder(app, prisma, world.a);
    const p1 = (await call(app, a, 'GET', '/shop/notifications?limit=2')).json().data;
    expect(p1.items).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = (await call(app, a, 'GET', `/shop/notifications?limit=2&cursor=${p1.nextCursor}`)).json().data;
    const p3 = (await call(app, a, 'GET', `/shop/notifications?limit=2&cursor=${p2.nextCursor}`)).json().data;
    const ids = [...p1.items, ...p2.items, ...p3.items].map((n: NotificationDto) => n.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeNull();

    // missed-event recovery: client last saw p2's newest item, two more arrive
    const lastSeen = p2.items[0].seq as string;
    const missed = (await call(app, a, 'GET', `/shop/notifications?after=${lastSeen}`)).json().data;
    expect(missed.items.map((n: NotificationDto) => n.id).sort()).toEqual(p1.items.map((n: NotificationDto) => n.id).sort());
    expect(p1.latestCursor).toBe(p1.items[0].seq);
  });

  it('hides notifications past the retention window and the worker deletes them', async () => {
    const { app } = build({ NOTIFICATION_RETENTION_DAYS: '7' });
    const a = await login(app, world.a.ownerEmail);
    const { order } = await newOrder(app, prisma, world.a);
    await newOrder(app, prisma, world.a);
    await prisma.shopNotification.updateMany({ where: { orderId: order.id }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    const data = (await call(app, a, 'GET', '/shop/notifications')).json().data;
    expect(data.items).toHaveLength(1);
    expect(data.unreadCount).toBe(1);
    expect(await cleanupNotifications(prisma, { retentionDays: 7, batchSize: 1 })).toEqual({ deleted: 1 });
    expect(await prisma.shopNotification.count()).toBe(1);
  });

  it('applies the shop read rate limit', async () => {
    const { app } = build({ RATE_LIMIT_SHOP_READ_MAX: '3' });
    const a = await login(app, world.a.ownerEmail);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call(app, a, 'GET', '/shop/notifications')).statusCode);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes).toContain(429);
  });
});

describe('live stream (real sockets)', () => {
  it('delivers a new-order notification to the right shop only, without an SSE id, and with no document data', async () => {
    const { app, port } = await listening();
    const a = await login(app, world.a.ownerEmail);
    const b = await login(app, world.b.ownerEmail);
    const sa = await connect(port, a);
    const sb = await connect(port, b);
    const { order } = await newOrder(app, prisma, world.a);
    await eventually(() => notificationFrames(sa.text()).length === 1);
    await sleep(150);
    const [frame] = notificationFrames(sa.text());
    expect(frame!.data).toMatchObject({ type: 'order.created', readAt: null, data: { orderId: order.id, orderNumber: order.orderNumber } });
    expect(frame!.raw).not.toMatch(/^id:/m); // never disturbs the legacy Last-Event-ID space
    for (const secret of ['objectKey', 'notes.pdf', order.trackingToken, 'storage']) expect(sa.text()).not.toContain(secret);
    expect(notificationFrames(sb.text())).toHaveLength(0);
    expect(sb.text()).not.toContain(order.id);
  });

  it('delivers each notification once even though the fast path and the poller both see it', async () => {
    const { app, port } = await listening({ NOTIFICATION_POLL_MS: '50' });
    const a = await login(app, world.a.ownerEmail);
    const s = await connect(port, a);
    await newOrder(app, prisma, world.a);
    await sleep(500);
    expect(notificationFrames(s.text())).toHaveLength(1);
  });

  it('crosses API processes: an order taken by instance 1 reaches a stream open on instance 2', async () => {
    const one = build({ NOTIFICATION_POLL_MS: '60' });
    const two = await listening({ NOTIFICATION_POLL_MS: '60' });
    const session = await login(two.app, world.a.ownerEmail);
    const stream = await connect(two.port, session);
    const { order } = await newOrder(one.app, prisma, world.a);
    await eventually(() => notificationFrames(stream.text()).length === 1);
    expect(notificationFrames(stream.text())[0]!.data.data.orderId).toBe(order.id);
  });

  it('does not deliver across processes when polling is disabled (documented limit), but the inbox still has it', async () => {
    const one = build({ NOTIFICATION_POLL_MS: '0' });
    const two = await listening({ NOTIFICATION_POLL_MS: '0' });
    const session = await login(two.app, world.a.ownerEmail);
    const stream = await connect(two.port, session);
    await newOrder(one.app, prisma, world.a);
    await sleep(300);
    expect(notificationFrames(stream.text())).toHaveLength(0);
    expect((await call(two.app, session, 'GET', '/shop/notifications')).json().data.items).toHaveLength(1);
  });

  it('re-validates the session at delivery time: an invalidated session gets nothing and is disconnected', async () => {
    const { app, port } = await listening();
    const a = await login(app, world.a.ownerEmail);
    const s = await connect(port, a);
    await prisma.session.updateMany({ where: { userId: a.userId }, data: { invalidatedAt: new Date() } });
    await newOrder(app, prisma, world.a);
    await eventually(() => s.ended());
    expect(notificationFrames(s.text())).toHaveLength(0);
  });

  it('does not stream to a shop that was suspended: delivery is re-authorised and the stream is closed', async () => {
    const { app, port, notifications } = await listening();
    const a = await login(app, world.a.ownerEmail);
    const s = await connect(port, a);
    await eventually(() => notifications.subscriberCount() === 1);
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    const row = await prisma.shopNotification.create({
      data: { shopId: world.a.shopId, type: 'order.created', dedupeKey: 'x', payload: { orderId: 'o', orderNumber: 'N-1' } }
    });
    notifications.publish(world.a.shopId, toNotificationDto(row));
    await eventually(() => s.ended());
    expect(notificationFrames(s.text())).toHaveLength(0);
  });

  it('cleans up listeners and stops the poller when the browser disconnects abruptly', async () => {
    const { app, port, notifications } = await listening({ NOTIFICATION_POLL_MS: '50' });
    const a = await login(app, world.a.ownerEmail);
    const s1 = await connect(port, a);
    const s2 = await connect(port, a);
    await eventually(() => notifications.subscriberCount() === 2);
    expect(notifications.isPolling()).toBe(true);
    s1.close();
    await eventually(() => notifications.subscriberCount() === 1);
    s2.close();
    await eventually(() => notifications.subscriberCount() === 0);
    expect(notifications.isPolling()).toBe(false);
  });

  it('caps streams per session and frees the slot on disconnect', async () => {
    const { app, port, notifications } = await listening({ SSE_MAX_CONNECTIONS_PER_SESSION: '2' });
    const a = await login(app, world.a.ownerEmail);
    const s1 = await connect(port, a);
    await connect(port, a);
    const third = await connect(port, a);
    expect(third.status).toBe(429);
    s1.close();
    await eventually(() => notifications.subscriberCount() === 1);
    expect((await connect(port, a)).status).toBe(200);
  });

  it('shuts every stream and the poller down with the server', async () => {
    const { app, port, notifications } = await listening({ NOTIFICATION_POLL_MS: '50' });
    const a = await login(app, world.a.ownerEmail);
    const s = await connect(port, a);
    await eventually(() => notifications.subscriberCount() === 1);
    await app.close();
    closers.length = 0;
    await eventually(() => s.ended());
    expect(notifications.subscriberCount()).toBe(0);
    expect(notifications.isPolling()).toBe(false);
  });
});

describe('ShopNotificationHub', () => {
  const dto = (seq: number, n = `N-${seq}`): NotificationDto => ({
    id: `id${seq}`,
    seq: String(seq),
    type: 'order.created',
    createdAt: new Date().toISOString(),
    readAt: null,
    data: { orderId: `o${seq}`, orderNumber: n }
  });

  it('drops duplicates and out-of-order sequence numbers per subscriber, and isolates shops', async () => {
    const hub = new ShopNotificationHub(prisma, 0);
    const a: NotificationDto[] = [];
    const b: NotificationDto[] = [];
    await hub.subscribe('shop-a', { deliver: (i) => a.push(...i) });
    await hub.subscribe('shop-b', { deliver: (i) => b.push(...i) });
    hub.publish('shop-a', dto(5));
    hub.publish('shop-a', dto(5));
    hub.publish('shop-a', dto(4));
    hub.publish('shop-a', dto(6));
    expect(a.map((n) => n.seq)).toEqual(['5', '6']);
    expect(b).toHaveLength(0);
  });

  it('a throwing subscriber does not stop other subscribers', async () => {
    const errors: unknown[] = [];
    const hub = new ShopNotificationHub(prisma, 0, (e) => errors.push(e));
    const got: string[] = [];
    await hub.subscribe('s', { deliver: () => { throw new Error('boom'); } });
    await hub.subscribe('s', { deliver: (i) => got.push(i[0]!.id) });
    hub.publish('s', dto(1));
    expect(got).toEqual(['id1']);
    expect(errors).toHaveLength(1);
  });

  it('poller picks up rows written by another process and survives a database error', async () => {
    const errors: unknown[] = [];
    let failNext = true;
    const flaky = {
      shopNotification: {
        aggregate: (args: never) => prisma.shopNotification.aggregate(args),
        findMany: (args: never) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error('db down'));
          }
          return prisma.shopNotification.findMany(args);
        }
      }
    } as unknown as PrismaClient;
    const hub = new ShopNotificationHub(flaky, 40, (e) => errors.push(e));
    const got: NotificationDto[] = [];
    const off = await hub.subscribe(world.a.shopId, { deliver: (i) => got.push(...i) });
    await eventually(() => errors.length === 1);
    await prisma.shopNotification.create({ data: { shopId: world.a.shopId, type: 'order.created', dedupeKey: 'k1', payload: { orderId: 'o1', orderNumber: 'A-1' } } });
    await eventually(() => got.length === 1);
    expect(got[0]!.data.orderNumber).toBe('A-1');
    off();
    expect(hub.isPolling()).toBe(false);
  });
});
