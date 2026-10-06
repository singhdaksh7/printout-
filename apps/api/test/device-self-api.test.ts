import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { devicePresence, HEARTBEAT_INTERVAL_SECONDS } from '../src/domain/device-presence.js';
import { buildApp, call, login, newOrder, seedDevice, seedWorld, testConfig, type World } from './api-helpers.js';
import { testPrisma } from './helpers/db.js';

const TOKEN = 'fcm-token-' + 'A1b2C3d4E5'.repeat(8);
const TOKEN2 = 'fcm-token-' + 'Z9y8X7w6V5'.repeat(8);

let app: FastifyInstance;
let prisma: PrismaClient;
let world: World;

const hb = (auth: Record<string, string>, body?: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/device/heartbeat', headers: auth, ...(body === undefined ? {} : { payload: body as object }) });
const put = (auth: Record<string, string>, body: unknown) =>
  app.inject({ method: 'PUT', url: '/api/v1/device/push-token', headers: auth, payload: body as object });

async function boot(overrides: Record<string, string> = {}) {
  const built = buildApp(overrides);
  app = built.app;
  prisma = built.prisma;
  world = await seedWorld(prisma);
}

beforeEach(() => boot());
afterEach(async () => {
  await app.close();
});

describe('POST /device/heartbeat', () => {
  it('updates presence, returns the contract shape and is not audited', async () => {
    const { device, auth } = await seedDevice(prisma, world.a.shopId, { lastSeenAt: new Date(Date.now() - 3600e3) });
    expect(devicePresence({ status: 'ACTIVE', lastSeenAt: device.lastSeenAt })).toBe('OFFLINE');
    const res = await hb(auth, { appVersion: '1.2.3', osVersion: 'Android 14' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.heartbeatIntervalSeconds).toBe(HEARTBEAT_INTERVAL_SECONDS);
    expect(data.device).toEqual({ id: device.id, name: device.name });
    expect(new Date(data.serverTime).getTime()).toBeGreaterThan(Date.now() - 5000);
    const row = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(devicePresence(row)).toBe('ONLINE');
    expect(row.appVersion).toBe('1.2.3');
    expect(row.osVersion).toBe('Android 14');
    expect(await prisma.auditLog.count({ where: { shopId: world.a.shopId } })).toBe(0);
  });

  it('accepts an empty body and goes OFFLINE when lastSeenAt is old', async () => {
    const { device, auth } = await seedDevice(prisma, world.a.shopId);
    expect((await hb(auth)).statusCode).toBe(200);
    expect((await hb(auth, {})).statusCode).toBe(200);
    await prisma.shopDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(Date.now() - 10 * 60e3) } });
    const row = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(devicePresence(row)).toBe('OFFLINE');
  });

  it('throttles lastSeenAt writes inside the interval but persists a version change immediately', async () => {
    const { device, auth } = await seedDevice(prisma, world.a.shopId);
    await hb(auth, { appVersion: '1.0.0' });
    const first = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(first.lastSeenAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    await hb(auth, { appVersion: '1.0.0' });
    const second = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(second.lastSeenAt!.getTime()).toBe(first.lastSeenAt!.getTime());
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    await hb(auth, { appVersion: '1.0.1' });
    const third = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(third.appVersion).toBe('1.0.1');
    expect(third.lastSeenAt!.getTime()).toBeGreaterThan(first.lastSeenAt!.getTime());
    // Once the stored value is older than the interval a write happens again.
    await prisma.shopDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(Date.now() - 120e3) } });
    await hb(auth, { appVersion: '1.0.1' });
    const fourth = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(Date.now() - fourth.lastSeenAt!.getTime()).toBeLessThan(10_000);
  });

  it('concurrent heartbeats are safe', async () => {
    const { device, auth } = await seedDevice(prisma, world.a.shopId);
    const results = await Promise.all(Array.from({ length: 15 }, () => hb(auth, { appVersion: '2.0.0' })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const row = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.appVersion).toBe('2.0.0');
    expect(row.lastSeenAt).not.toBeNull();
  });

  it('rejects unauthenticated, malformed, unknown, revoked, suspended-shop and inactive-subscription devices', async () => {
    expect((await hb({})).statusCode).toBe(401);
    expect((await hb({ authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect((await hb({ authorization: 'Bearer pbd_' + 'x'.repeat(43) })).statusCode).toBe(401);
    const revoked = await seedDevice(prisma, world.a.shopId, { status: 'REVOKED' });
    const r = await hb(revoked.auth);
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('DEVICE_REVOKED');
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: revoked.device.id } })).lastSeenAt).toBeNull();

    const b = await seedDevice(prisma, world.b.shopId);
    await prisma.subscription.updateMany({ where: { shopId: world.b.shopId }, data: { status: 'SUSPENDED' } });
    const s = await hb(b.auth);
    expect(s.statusCode).toBe(403);
    expect(s.json().error.code).toBe('SUBSCRIPTION_INACTIVE');
    await prisma.subscription.updateMany({ where: { shopId: world.b.shopId }, data: { status: 'ACTIVE' } });
    await prisma.shop.update({ where: { id: world.b.shopId }, data: { status: 'SUSPENDED' } });
    const t = await hb(b.auth);
    expect(t.statusCode).toBe(403);
    expect(t.json().error.code).toBe('SHOP_SUSPENDED');
  });

  it('device A cannot affect device B and a body cannot choose another device or shop', async () => {
    const a = await seedDevice(prisma, world.a.shopId, { name: 'A' });
    const b = await seedDevice(prisma, world.b.shopId, { name: 'B' });
    const res = await hb(a.auth, { deviceId: b.device.id, shopId: world.b.shopId });
    expect(res.statusCode).toBe(400);
    await hb(a.auth, { appVersion: '9.9.9' });
    const rowB = await prisma.shopDevice.findUniqueOrThrow({ where: { id: b.device.id } });
    expect(rowB.lastSeenAt).toBeNull();
    expect(rowB.appVersion).toBeNull();
  });

  it('validates the body strictly', async () => {
    const { auth } = await seedDevice(prisma, world.a.shopId);
    for (const body of [{ appVersion: 5 }, { appVersion: '' }, { appVersion: 'x'.repeat(41) }, { osVersion: 'y'.repeat(61) }, { extra: 1 }]) {
      expect((await hb(auth, body)).statusCode).toBe(400);
    }
  });

  it('is rate limited per device (429) with a low override', async () => {
    await app.close();
    await boot({ RATE_LIMIT_DEVICE_MUTATION_MAX: '3' });
    const a = await seedDevice(prisma, world.a.shopId);
    const b = await seedDevice(prisma, world.a.shopId);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await hb(a.auth)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await hb(b.auth)).statusCode).toBe(200);
  });
});

describe('GET /device/me', () => {
  it('returns only id, name, platform and shop name', async () => {
    const { device, auth } = await seedDevice(prisma, world.a.shopId, { name: 'Front' });
    await prisma.shopDevice.update({ where: { id: device.id }, data: { pushToken: TOKEN } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/device/me', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ device: { id: device.id, name: 'Front', platform: 'ANDROID', shopName: 'Sharma Print' } });
    expect(res.body).not.toContain(TOKEN);
    expect((await app.inject({ method: 'GET', url: '/api/v1/device/me' })).statusCode).toBe(401);
  });
});

describe('PUT /device/push-token', () => {
  it('stores the token, never echoes it, audits without it, and is idempotent', async () => {
    const { device, auth } = await seedDevice(prisma, world.a.shopId);
    const res = await put(auth, { token: `  ${TOKEN}  ` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ok: true } });
    expect(res.body).not.toContain(TOKEN);
    const row = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.pushToken).toBe(TOKEN);
    expect(row.pushTokenUpdatedAt).not.toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { shopId: world.a.shopId, action: 'device.pushTokenUpdated' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorType).toBe('SHOP_DEVICE');
    expect(logs[0]!.actorDeviceId).toBe(device.id);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect((await put(auth, { token: TOKEN })).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'device.pushTokenUpdated' } })).toBe(1);
    expect((await put(auth, { token: TOKEN2 })).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'device.pushTokenUpdated' } })).toBe(2);
  });

  it('is ANDROID only and validates the body strictly', async () => {
    const win = await seedDevice(prisma, world.a.shopId, { platform: 'WINDOWS' });
    const r = await put(win.auth, { token: TOKEN });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CONFLICT');
    const { auth } = await seedDevice(prisma, world.a.shopId);
    for (const body of [{}, { token: 'short' }, { token: 'x'.repeat(4097) }, { token: 123 }, { token: TOKEN, extra: 1 }]) {
      expect((await put(auth, body)).statusCode).toBe(400);
    }
    expect((await put({}, { token: TOKEN })).statusCode).toBe(401);
    const revoked = await seedDevice(prisma, world.a.shopId, { status: 'REVOKED' });
    expect((await put(revoked.auth, { token: TOKEN })).statusCode).toBe(401);
  });

  it('a token maps to one device: re-registering it clears the older row', async () => {
    const old = await seedDevice(prisma, world.a.shopId, { name: 'old' });
    const fresh = await seedDevice(prisma, world.a.shopId, { name: 'fresh' });
    await put(old.auth, { token: TOKEN });
    await put(fresh.auth, { token: TOKEN });
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: old.device.id } })).pushToken).toBeNull();
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: fresh.device.id } })).pushToken).toBe(TOKEN);
  });

  it('the token never appears in any API response I can reach (deep scan) nor in logs', async () => {
    let logged = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logged += chunk.toString();
        cb();
      }
    });
    await app.close();
    const p = testPrisma();
    const built = createApp({ config: testConfig({ NODE_ENV: 'development' }), prisma: p, logStream: stream });
    app = built.app;
    prisma = p;
    world = await seedWorld(prisma);
    const { auth } = await seedDevice(prisma, world.a.shopId);
    const put1 = await put(auth, { token: TOKEN });
    const bodies = [put1.body];
    bodies.push((await hb(auth, { appVersion: '1' })).body);
    bodies.push((await app.inject({ method: 'GET', url: '/api/v1/device/me', headers: auth })).body);
    const bad = await put(auth, { token: TOKEN + '!', extra: TOKEN });
    bodies.push(bad.body);
    const o = await newOrder(app, prisma, world.a);
    const owner = await login(app, world.a.ownerEmail);
    bodies.push((await call(app, owner, 'GET', '/shop/orders')).body);
    bodies.push((await call(app, owner, 'GET', `/shop/orders/${o.order.id}`)).body);
    bodies.push((await app.inject({ method: 'GET', url: `/api/v1/public/orders/${o.trackingToken}` })).body);
    for (const b of bodies) expect(b).not.toContain(TOKEN);
    expect(logged).toContain('incoming request');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('A1b2C3d4E5');
  });
});
