import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { startWorker } from '../src/worker.js';
import { DeviceNotifier } from '../src/notifications/device-notifier.js';
import { NoopNotifier } from '../src/notifications/noop.js';
import { RecordingPushProvider } from '../src/notifications/providers.js';
import { call, login, newOrder, seedWorld, testConfig, type Session, type World } from './api-helpers.js';
import { testPrisma } from './helpers/db.js';

/**
 * Phase 2 end-to-end owner/device flow over the real HTTP routes (fastify inject), exactly as the web client and a device app
 * would drive it: pairing -> heartbeat -> presence -> order -> push signal -> device list -> print -> reprint/download ->
 * revoke -> expiry denial -> worker cleanup.
 */
const prisma = testPrisma();
const provider = new RecordingPushProvider();
const notifier = new DeviceNotifier(prisma, provider);
const built = createApp({ config: testConfig(), prisma, notifier });
const { app, events, storage, config } = built;

let world: World;
let owner: Session;
beforeAll(async () => {
  await app.ready();
  world = await seedWorld(prisma);
  owner = await login(app, world.a.ownerEmail);
});
afterAll(() => app.close());

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const dev = (secret: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: bearer(secret), ...(payload === undefined ? {} : { payload: payload as object }) });
const patch = (url: string, body: unknown) =>
  app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf }, payload: body as object });
const PUSH_TOKEN = `fcm-integration-${'t'.repeat(40)}`;

describe('default notifier wiring', () => {
  it('createApp defaults to the no-op notifier and honours the deps.notifier override', () => {
    expect(createApp({ config: testConfig(), prisma }).notifier).toBeInstanceOf(NoopNotifier);
    expect(built.notifier).toBe(notifier);
  });
});

describe('Phase 2 device foundation: full flow', () => {
  const state = { secret: '', deviceId: '', orderId: '', docId: '', objectKey: '' };
  const seen: Array<{ event: string; data: { status?: string; id?: string } }> = [];
  let unsubscribe: () => void = () => undefined;

  it('owner creates a pairing code; device pairs; the code is single use', async () => {
    unsubscribe = events.subscribe(world.a.shopId, {
      write: (chunk) => {
        const m = /event: (.+)\ndata: (.+)\n/.exec(chunk);
        if (m) seen.push({ event: m[1]!, data: JSON.parse(m[2]!) });
      },
      close: () => undefined
    });
    expect((await call(app, owner, 'GET', '/shop/devices')).json().data.devices).toEqual([]);
    const created = await call(app, owner, 'POST', '/shop/devices/pairing-codes', {});
    expect(created.statusCode).toBe(200);
    const { code, expiresAt } = created.json().data as { code: string; expiresAt: string };
    expect(code).toMatch(/^PB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const pair = await app.inject({
      method: 'POST',
      url: '/api/v1/device/pair',
      payload: { code, deviceName: 'Counter phone', platform: 'ANDROID', appVersion: '1.0.0', osVersion: 'Android 14' }
    });
    expect(pair.statusCode).toBe(200);
    const paired = pair.json().data;
    expect(paired.deviceCredential).toMatch(/^pbd_[A-Za-z0-9_-]{43}$/);
    expect(paired.shop).toEqual({ displayName: 'Sharma Print' });
    expect(paired.heartbeatIntervalSeconds).toBe(60);
    state.secret = paired.deviceCredential;
    state.deviceId = paired.deviceId;

    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/device/pair',
      payload: { code, deviceName: 'Second', platform: 'WINDOWS' }
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('PAIRING_CODE_INVALID');
    // The raw credential is never stored.
    const row = await prisma.shopDevice.findUniqueOrThrow({ where: { id: state.deviceId } });
    expect(row.credentialHash).not.toContain(state.secret);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(state.secret);
  });

  it('heartbeat makes the device ONLINE in the owner list; owner view never leaks secrets; rename works', async () => {
    let list = (await call(app, owner, 'GET', '/shop/devices')).json().data.devices;
    expect(list).toHaveLength(1);
    expect(list[0].presence).toBe('OFFLINE'); // paired but not yet seen
    const hb = await dev(state.secret, 'POST', '/device/heartbeat', { appVersion: '1.0.1' });
    expect(hb.statusCode).toBe(200);
    expect(hb.json().data.device).toEqual({ id: state.deviceId, name: 'Counter phone' });
    list = (await call(app, owner, 'GET', '/shop/devices')).json().data.devices;
    expect(list[0]).toMatchObject({ id: state.deviceId, presence: 'ONLINE', status: 'ACTIVE', platform: 'ANDROID', appVersion: '1.0.1', revokedAt: null });
    expect(Object.keys(list[0]).sort()).toEqual([
      'appVersion', 'createdAt', 'id', 'lastSeenAt', 'name', 'platform', 'presence', 'revokedAt', 'status'
    ]);
    const renamed = await patch(`/shop/devices/${state.deviceId}`, { name: 'Front desk' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.device.name).toBe('Front desk');
    // another shop's owner cannot see or touch it
    const ownerB = await login(app, world.b.ownerEmail);
    expect((await call(app, ownerB, 'GET', '/shop/devices')).json().data.devices).toEqual([]);
    expect((await call(app, ownerB, 'POST', `/shop/devices/${state.deviceId}/revoke`, {})).statusCode).toBe(404);
  });

  it('push token + customer order: exactly one NEW_PRINT_REQUEST signal; device sees the order', async () => {
    const put = await dev(state.secret, 'PUT', '/device/push-token', { token: PUSH_TOKEN });
    expect(put.json().data).toEqual({ ok: true });
    expect(put.body).not.toContain(PUSH_TOKEN);
    const o = await newOrder(app, prisma, world.a);
    await notifier.flush();
    state.orderId = o.order.id;
    state.docId = o.doc.id;
    state.objectKey = o.doc.objectKey;
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toEqual({ token: PUSH_TOKEN, payload: { type: 'NEW_PRINT_REQUEST', orderId: o.order.id } });
    // put a real object behind the document so the worker has something to delete later
    await storage.put(o.doc.objectKey, Readable.from([Buffer.from('%PDF-1.4 integration')]), { maxBytes: 1_000_000, contentType: 'application/pdf' });

    const list = await dev(state.secret, 'GET', '/device/orders?print=pending');
    expect(list.statusCode).toBe(200);
    const items = list.json().data.items as Array<{ id: string; printInitiatedAt: string | null }>;
    expect(items.map((i) => i.id)).toEqual([o.order.id]);
    expect(items[0]!.printInitiatedAt).toBeNull();
    expect(JSON.stringify(list.json())).not.toMatch(/objectKey|bucket/);
    expect((await dev(state.secret, 'GET', `/device/orders/${o.order.id}`)).statusCode).toBe(200);
    // another shop's order is invisible to this device
    const other = await newOrder(app, prisma, world.b);
    expect((await dev(state.secret, 'GET', `/device/orders/${other.order.id}`)).statusCode).toBe(404);
  });

  it('device print starts retention once (+PRINT_RETENTION_MINUTES) and owner SSE receives order.statusChanged', async () => {
    seen.length = 0;
    const before = Date.now();
    const print = await dev(state.secret, 'POST', `/device/orders/${state.orderId}/print`, { clientRequestId: randomUUID() });
    expect(print.statusCode).toBe(200);
    const body = print.json().data;
    expect(body.firstPrint).toBe(true);
    expect(body.transitioned).toBe(true);
    expect(body.order.status).toBe('PRINTING');
    expect(body.access.contentDisposition).toBe('inline');
    const d = await prisma.document.findUniqueOrThrow({ where: { id: state.docId } });
    expect(d.printInitiatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(d.deleteAfter!.getTime() - d.printInitiatedAt!.getTime()).toBe(config.PRINT_RETENTION_MINUTES * 60_000);
    expect(new Date(body.document.printInitiatedAt).getTime()).toBe(d.printInitiatedAt!.getTime());
    expect(new Date(body.document.deleteAfter).getTime()).toBe(d.deleteAfter!.getTime());
    expect(seen.some((e) => e.event === 'order.statusChanged' && e.data.status === 'PRINTING' && e.data.id === state.orderId)).toBe(true);
    expect(seen.some((e) => e.event === 'document.deletionScheduled')).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { targetId: state.orderId, action: 'order.printInitiated' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'SHOP_DEVICE', actorDeviceId: state.deviceId, actorUserId: null });
    // device now lists it under initiated, no longer pending
    expect((await dev(state.secret, 'GET', '/device/orders?print=pending')).json().data.items).toHaveLength(0);
    expect((await dev(state.secret, 'GET', '/device/orders?print=initiated')).json().data.items).toHaveLength(1);
  });

  it('browser print/reprint is idempotent; device reprint and download never move the timestamps', async () => {
    const t0 = await prisma.document.findUniqueOrThrow({ where: { id: state.docId } });
    const browser = await call(app, owner, 'POST', `/shop/orders/${state.orderId}/print-now`, { clientRequestId: randomUUID() });
    expect(browser.statusCode).toBe(200);
    expect(browser.json().data.firstPrint).toBe(false);
    expect(browser.json().data.transitioned).toBe(false);
    expect(new Date(browser.json().data.document.printInitiatedAt).getTime()).toBe(t0.printInitiatedAt!.getTime());
    expect(new Date(browser.json().data.document.deleteAfter).getTime()).toBe(t0.deleteAfter!.getTime());
    const devPrintAgain = await dev(state.secret, 'POST', `/device/orders/${state.orderId}/print`, { clientRequestId: randomUUID() });
    expect(devPrintAgain.json().data.firstPrint).toBe(false);
    const re = await dev(state.secret, 'POST', `/device/orders/${state.orderId}/reprint`, {});
    expect(re.statusCode).toBe(200);
    expect(re.json().data.contentDisposition).toBe('inline');
    const dl = await dev(state.secret, 'POST', `/device/orders/${state.orderId}/download`, {});
    expect(dl.statusCode).toBe(200);
    expect(dl.json().data.contentDisposition).toBe('attachment');
    expect(new Date(dl.json().data.expiresAt).getTime()).toBeLessThanOrEqual(t0.deleteAfter!.getTime());
    const t1 = await prisma.document.findUniqueOrThrow({ where: { id: state.docId } });
    expect(t1.printInitiatedAt!.getTime()).toBe(t0.printInitiatedAt!.getTime());
    expect(t1.deleteAfter!.getTime()).toBe(t0.deleteAfter!.getTime());
    expect(await prisma.auditLog.count({ where: { targetId: state.orderId, action: 'order.printInitiated' } })).toBe(1);
    const edges = (
      await prisma.orderStatusHistory.findMany({ where: { orderId: state.orderId, fromStatus: { not: null } }, orderBy: { createdAt: 'asc' } })
    ).map((h) => `${h.fromStatus}->${h.toStatus}`);
    expect(edges).toEqual(['NEW->ACCEPTED', 'ACCEPTED->PRINTING']);
  });

  it('owner revokes the device: every device route answers 401 DEVICE_REVOKED immediately', async () => {
    const rev = await call(app, owner, 'POST', `/shop/devices/${state.deviceId}/revoke`, {});
    expect(rev.statusCode).toBe(200);
    expect(rev.json().data.device).toMatchObject({ status: 'REVOKED', presence: 'REVOKED' });
    const id = state.orderId;
    const results = await Promise.all([
      dev(state.secret, 'POST', '/device/heartbeat', {}),
      dev(state.secret, 'PUT', '/device/push-token', { token: PUSH_TOKEN }),
      dev(state.secret, 'GET', '/device/me'),
      dev(state.secret, 'GET', '/device/orders'),
      dev(state.secret, 'GET', `/device/orders/${id}`),
      dev(state.secret, 'POST', `/device/orders/${id}/print`, { clientRequestId: randomUUID() }),
      dev(state.secret, 'POST', `/device/orders/${id}/reprint`, {}),
      dev(state.secret, 'POST', `/device/orders/${id}/download`, {})
    ]);
    for (const r of results) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('DEVICE_REVOKED');
    }
    // revoke is idempotent and clears the push token; a revoked device is no longer signalled
    expect((await call(app, owner, 'POST', `/shop/devices/${state.deviceId}/revoke`, {})).statusCode).toBe(200);
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: state.deviceId } })).pushToken).toBeNull();
    const sentBefore = provider.sent.length;
    await newOrder(app, prisma, world.a);
    await notifier.flush();
    expect(provider.sent).toHaveLength(sentBefore);
    // garbage / missing credentials are plain 401 UNAUTHORIZED
    const bad = await dev('pbd_' + 'x'.repeat(43), 'GET', '/device/me');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('UNAUTHORIZED');
    expect((await app.inject({ method: 'GET', url: '/api/v1/device/me' })).statusCode).toBe(401);
  });

  it('after deleteAfter access is denied before the worker runs; the worker then deletes the object', async () => {
    // owner (browser) path: access still works inside the window
    expect((await call(app, owner, 'POST', `/shop/orders/${state.orderId}/document-access`, {})).statusCode).toBe(200);
    expect(await storage.exists(state.objectKey)).toBe(true);
    // time passes: the retention deadline is now in the past
    await prisma.document.update({ where: { id: state.docId }, data: { deleteAfter: new Date(Date.now() - 1000) } });
    const denied = await call(app, owner, 'POST', `/shop/orders/${state.orderId}/document-access`, {});
    expect(denied.statusCode).toBe(410);
    expect(denied.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
    expect((await call(app, owner, 'POST', `/shop/orders/${state.orderId}/document-download`, {})).statusCode).toBe(410);
    expect((await call(app, owner, 'POST', `/shop/orders/${state.orderId}/print-now`, { clientRequestId: randomUUID() })).statusCode).toBe(409);
    // object still there: the denial does not depend on the worker
    expect(await storage.exists(state.objectKey)).toBe(true);
    const worker = startWorker({ prisma, storage, argv: ['--once'], log: {} });
    await worker.done;
    expect(worker.runs[0]!.deleted).toBe(1);
    expect(await storage.exists(state.objectKey)).toBe(false);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: state.docId } })).status).toBe('DELETED');
    unsubscribe();
  });
});
