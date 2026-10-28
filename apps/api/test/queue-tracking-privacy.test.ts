import { randomUUID } from 'node:crypto';
import { DevicePrintJobStatus, DocumentStatus, OrderStatus, type PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupExpiredDocuments } from '../src/cleanup.js';
import { buildApp, call, login, newOrder, seedDevice, seedWorld, type Session, type World } from './api-helpers.js';
import { MemoryStorage, minutes } from './helpers/retention.js';

const { app, prisma } = buildApp();
let world: World;
let a: Session;
let b: Session;

async function addJob(db: PrismaClient, shopId: string, orderId: string, documentId: string, status: DevicePrintJobStatus, extra: { leaseExpiresAt?: Date; createdAt?: Date } = {}) {
  const { device } = await seedDevice(db, shopId, { platform: 'WINDOWS' });
  const printer = await db.devicePrinter.upsert({
    where: { deviceId_name: { deviceId: device.id, name: 'HP' } },
    update: {},
    create: { shopId, deviceId: device.id, name: 'HP', authorized: true }
  });
  return db.devicePrintJob.create({
    data: { shopId, orderId, documentId, deviceId: device.id, printerId: printer.id, status, clientRequestId: randomUUID(), options: {}, ...extra }
  });
}

const ids = (res: { json(): { data: { items: { id: string }[] } } }) => res.json().data.items.map((o) => o.id);

beforeEach(async () => {
  world = await seedWorld(prisma);
  a = await login(app, world.a.ownerEmail);
  b = await login(app, world.b.ownerEmail);
});

describe('queue sort, needs-attention filter and counts', () => {
  it('sorts oldest-first with a working keyset cursor; newest stays the default', async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) created.push((await newOrder(app, prisma, world.a)).order.id);
    expect(ids(await call(app, a, 'GET', '/shop/orders'))).toEqual([...created].reverse());
    const p1 = await call(app, a, 'GET', '/shop/orders?sort=oldest&limit=2');
    expect(ids(p1)).toEqual(created.slice(0, 2));
    const p2 = await call(app, a, 'GET', `/shop/orders?sort=oldest&limit=2&cursor=${p1.json().data.nextCursor}`);
    expect(ids(p2)).toEqual(created.slice(2));
    expect(p2.json().data.nextCursor).toBeUndefined();
    expect((await call(app, a, 'GET', '/shop/orders?sort=sideways')).statusCode).toBe(400);
  });

  it('lists only orders whose LATEST print job needs attention, scoped per shop; a newer good job clears it', async () => {
    const failed = await newOrder(app, prisma, world.a);
    const recovered = await newOrder(app, prisma, world.a);
    const clean = await newOrder(app, prisma, world.a);
    const other = await newOrder(app, prisma, world.b);
    const t0 = new Date('2026-10-01T10:00:00Z');
    await addJob(prisma, world.a.shopId, failed.order.id, failed.doc.id, 'NEEDS_RECONCILIATION', { createdAt: t0 });
    await addJob(prisma, world.a.shopId, recovered.order.id, recovered.doc.id, 'FAILED', { createdAt: t0 });
    await addJob(prisma, world.a.shopId, recovered.order.id, recovered.doc.id, 'PRINT_INITIATED', { createdAt: minutes(t0, 5) });
    await addJob(prisma, world.b.shopId, other.order.id, other.doc.id, 'FAILED', { createdAt: t0 });

    const list = ids(await call(app, a, 'GET', '/shop/orders?print=attention'));
    expect(list).toEqual([failed.order.id]);
    expect(list).not.toContain(clean.order.id);
    expect(ids(await call(app, b, 'GET', '/shop/orders?print=attention'))).toEqual([other.order.id]);
    expect((await call(app, a, 'GET', '/shop/orders/counts')).json().data).toEqual({ pending: 3, attention: 1 });
    expect((await call(app, b, 'GET', '/shop/orders/counts')).json().data).toEqual({ pending: 1, attention: 1 });
  });

  it('counts exclude cancelled orders and require a session', async () => {
    const o = await newOrder(app, prisma, world.a);
    await call(app, a, 'POST', `/shop/orders/${o.order.id}/transitions`, { toStatus: 'CANCELLED', clientRequestId: randomUUID() });
    expect((await call(app, a, 'GET', '/shop/orders/counts')).json().data.pending).toBe(0);
    const anon = await app.inject({ method: 'GET', url: '/api/v1/shop/orders/counts' });
    expect(anon.statusCode).toBeGreaterThanOrEqual(401);
  });
});

describe('customer tracking', () => {
  const track = (token: string) => app.inject({ method: 'GET', url: `/api/v1/public/orders/${token}` });

  it('exposes pickup info and a coarse printIssue flag, and nothing internal', async () => {
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { address: '12 Market Rd' } });
    await prisma.shopSettings.update({ where: { shopId: world.a.shopId }, data: { publicContact: '+91 98000 00000' } });
    const o = await newOrder(app, prisma, world.a);
    let body = (await track(o.trackingToken)).json().data;
    expect(body.pickup).toEqual({ address: '12 Market Rd', contact: '+91 98000 00000' });
    expect(body.printIssue).toBe(false);

    await addJob(prisma, world.a.shopId, o.order.id, o.doc.id, 'FAILED');
    body = (await track(o.trackingToken)).json().data;
    expect(body.printIssue).toBe(true);
    const raw = JSON.stringify(body);
    for (const secret of [o.order.id, o.doc.id, o.doc.objectKey, world.a.shopId, '"HP"', 'deviceId', 'errorMessage', 'objectKey']) expect(raw).not.toContain(secret);
  });

  it('clears printIssue on terminal orders and hides the file name once the file is deleted', async () => {
    const o = await newOrder(app, prisma, world.a);
    await addJob(prisma, world.a.shopId, o.order.id, o.doc.id, 'NEEDS_RECONCILIATION');
    expect((await track(o.trackingToken)).json().data.document.fileName).toBeTruthy();
    await prisma.document.update({ where: { id: o.doc.id }, data: { status: DocumentStatus.DELETED, deletedAt: new Date() } });
    await prisma.order.update({ where: { id: o.order.id }, data: { status: OrderStatus.CANCELLED } });
    const body = (await track(o.trackingToken)).json().data;
    expect(body.printIssue).toBe(false);
    expect(body.document.fileName).toBeNull();
    expect(body.document.status).toBe('DELETED');
  });

  it('answers malformed and unknown tokens identically (no enumeration signal)', async () => {
    const unknown = await track('x'.repeat(43));
    const malformed = await track('bad%20token!');
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe(malformed.json().error.code);
  });

  it('a token resolves only its own order (cross-shop isolation)', async () => {
    const mine = await newOrder(app, prisma, world.a);
    const theirs = await newOrder(app, prisma, world.b);
    const body = (await track(mine.trackingToken)).json().data;
    expect(body.orderNumber).toBe(mine.order.orderNumber);
    expect(body.shopName).toBe('Sharma Print');
    expect(JSON.stringify((await track(theirs.trackingToken)).json().data)).not.toContain('Sharma Print');
  });
});

describe('cleanup vs in-flight print jobs', () => {
  const T0 = new Date('2026-10-04T12:00:00.000Z');
  async function setup(jobStatus: DevicePrintJobStatus, leaseOffsetMin: number | null) {
    const storage = new MemoryStorage();
    const o = await newOrder(app, prisma, world.a);
    storage.put(o.doc.objectKey);
    await prisma.document.update({ where: { id: o.doc.id }, data: { expiresAt: T0 } });
    await addJob(prisma, world.a.shopId, o.order.id, o.doc.id, jobStatus, leaseOffsetMin === null ? {} : { leaseExpiresAt: minutes(T0, leaseOffsetMin) });
    return { storage, o };
  }

  it('spares a document with a live lease within the capped grace, then deletes it', async () => {
    const { storage, o } = await setup('DOWNLOADING', 10);
    let r = await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 1) });
    expect(r).toMatchObject({ deferred: 1, deleted: 0 });
    expect(storage.objects.has(o.doc.objectKey)).toBe(true);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: o.doc.id } })).status).toBe(DocumentStatus.AVAILABLE);
    // the grace is a hard cap: even a still-live lease cannot hold the file beyond it
    r = await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 5) });
    expect(r).toMatchObject({ deferred: 0, deleted: 1 });
    expect(storage.objects.has(o.doc.objectKey)).toBe(false);
  });

  it('does not spare expired leases, queued jobs or finished jobs', async () => {
    for (const [st, lease] of [['DOWNLOADING', -1], ['QUEUED', null], ['FAILED', null]] as const) {
      const { storage, o } = await setup(st, lease);
      const r = await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 1) });
      expect(r.deferred, st).toBe(0);
      expect(storage.objects.has(o.doc.objectKey), st).toBe(false);
    }
  });

  it('the grace can be disabled', async () => {
    const { storage, o } = await setup('SUBMITTING', 10);
    const r = await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 1), activeJobGraceMinutes: 0 });
    expect(r.deleted).toBe(1);
    expect(storage.objects.has(o.doc.objectKey)).toBe(false);
  });
});
