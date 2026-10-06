import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceGuard } from '../src/device-auth.js';
import { testPrisma } from './helpers/db.js';
import { buildApp, call, login, seedDevice, seedWorld, testConfig, type Session, type World } from './api-helpers.js';

const prisma = testPrisma();
let world: World;
let app: FastifyInstance;
let owner: Session;

beforeEach(async () => {
  world = await seedWorld(prisma);
  ({ app } = buildApp());
  app.register(async (i) => {
    i.get('/probe', { preHandler: deviceGuard({ prisma, config: testConfig() } as never) }, async () => ({ ok: true }));
  });
  owner = await login(app, world.a.ownerEmail);
});
afterEach(async () => {
  await app.close();
});

const patch = (s: Session | null, id: string, payload: unknown, csrf = true) =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/shop/devices/${id}`,
    headers: { ...(s ? { cookie: s.cookie } : {}), ...(s && csrf ? { 'x-csrf-token': s.csrf } : {}) },
    payload: payload as object
  });
const probe = (auth: { authorization: string }) => app.inject({ method: 'GET', url: '/probe', headers: auth });

describe('owner device management', () => {
  it('lists newest first including revoked, with a leak-free DeviceView', async () => {
    const old = await seedDevice(prisma, world.a.shopId, { name: 'Old', status: 'REVOKED' });
    const live = await seedDevice(prisma, world.a.shopId, { name: 'Live', lastSeenAt: new Date() });
    await prisma.shopDevice.update({ where: { id: live.device.id }, data: { pushToken: 'FCM-SECRET-TOKEN', osVersion: 'Android 14', appVersion: '1.2.3' } });
    await seedDevice(prisma, world.b.shopId, { name: 'Other shop' });
    const res = await call(app, owner, 'GET', '/shop/devices');
    expect(res.statusCode).toBe(200);
    const devices = res.json().data.devices;
    expect(devices.map((d: { name: string }) => d.name)).toEqual(['Live', 'Old']);
    expect(devices[0].presence).toBe('ONLINE');
    expect(devices[1].presence).toBe('REVOKED');
    expect(Object.keys(devices[0]).sort()).toEqual(
      ['appVersion', 'createdAt', 'id', 'lastSeenAt', 'name', 'platform', 'presence', 'revokedAt', 'status'].sort()
    );
    expect(devices[0].appVersion).toBe('1.2.3');
    const text = res.body;
    for (const needle of [live.secret, 'FCM-SECRET-TOKEN', 'Android 14', 'credentialHash', 'pushToken', world.a.shopId, live.device.credentialHash]) {
      expect(text).not.toContain(needle);
    }
  });

  it('renames (trimmed, 1-60), audits, and rejects bad input', async () => {
    const { device } = await seedDevice(prisma, world.a.shopId);
    const ok = await patch(owner, device.id, { name: '  Front desk  ' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.device.name).toBe('Front desk');
    expect(await prisma.auditLog.count({ where: { action: 'device.renamed', actorType: 'SHOP_OWNER', targetId: device.id } })).toBe(1);
    for (const bad of [{ name: '   ' }, { name: 'x'.repeat(61) }, {}, { name: 'a', extra: 1 }]) {
      expect((await patch(owner, device.id, bad)).statusCode).toBe(400);
    }
  });

  it('revoke is idempotent, clears the push token, audits once', async () => {
    const { device } = await seedDevice(prisma, world.a.shopId);
    await prisma.shopDevice.update({ where: { id: device.id }, data: { pushToken: 'tok', pushTokenUpdatedAt: new Date() } });
    const first = await call(app, owner, 'POST', `/shop/devices/${device.id}/revoke`, {});
    expect(first.statusCode).toBe(200);
    expect(first.json().data.device).toMatchObject({ status: 'REVOKED', presence: 'REVOKED' });
    const second = await call(app, owner, 'POST', `/shop/devices/${device.id}/revoke`, {});
    expect(second.statusCode).toBe(200);
    expect(second.json().data.device.revokedAt).toBe(first.json().data.device.revokedAt);
    const row = await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.pushToken).toBeNull();
    expect(row.revokedByUserId).toBe(owner.userId);
    expect(await prisma.auditLog.count({ where: { action: 'device.revoked' } })).toBe(1);
  });

  it('revocation takes effect immediately on the next guarded request', async () => {
    const { device, auth } = await seedDevice(prisma, world.a.shopId);
    expect((await probe(auth)).statusCode).toBe(200);
    await call(app, owner, 'POST', `/shop/devices/${device.id}/revoke`, {});
    const res = await probe(auth);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('DEVICE_REVOKED');
  });

  it('tenant isolation: other shop device is 404 for rename and revoke and stays untouched', async () => {
    const other = await seedDevice(prisma, world.b.shopId, { name: 'B device' });
    expect((await patch(owner, other.device.id, { name: 'hacked' })).statusCode).toBe(404);
    const rev = await call(app, owner, 'POST', `/shop/devices/${other.device.id}/revoke`, {});
    expect(rev.statusCode).toBe(404);
    expect(rev.json().error.code).toBe('NOT_FOUND');
    expect((await call(app, owner, 'POST', '/shop/devices/doesnotexist1234/revoke', {})).statusCode).toBe(404);
    const row = await prisma.shopDevice.findUniqueOrThrow({ where: { id: other.device.id } });
    expect(row).toMatchObject({ name: 'B device', status: 'ACTIVE' });
    expect((await probe(other.auth)).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'device.' } } })).toBe(0);
  });

  it('pairing codes are shop-scoped: the paired device lands in the creating shop', async () => {
    const ownerB = await login(app, world.b.ownerEmail);
    const code = (await call(app, ownerB, 'POST', '/shop/devices/pairing-codes', {})).json().data.code;
    const res = await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { code, deviceName: 'B tab', platform: 'WINDOWS' } });
    expect(res.json().data.shop.displayName).toBe('Metro Copies');
    expect((await call(app, owner, 'GET', '/shop/devices')).json().data.devices).toHaveLength(0);
    expect((await call(app, ownerB, 'GET', '/shop/devices')).json().data.devices).toHaveLength(1);
  });

  it('authz: anonymous 401, admin 403, CSRF required, device credential is not an owner session', async () => {
    const { device, auth } = await seedDevice(prisma, world.a.shopId);
    const admin = await login(app, world.adminEmail);
    expect((await call(app, null, 'GET', '/shop/devices')).statusCode).toBe(401);
    expect((await call(app, null, 'POST', '/shop/devices/pairing-codes', {})).statusCode).toBe(401);
    expect((await patch(null, device.id, { name: 'x' })).statusCode).toBe(401);
    expect((await call(app, null, 'POST', `/shop/devices/${device.id}/revoke`, {})).statusCode).toBe(401);
    expect((await call(app, admin, 'GET', '/shop/devices')).statusCode).toBe(403);
    expect((await call(app, admin, 'POST', '/shop/devices/pairing-codes', {})).statusCode).toBe(403);
    expect((await patch(admin, device.id, { name: 'x' })).statusCode).toBe(403);
    expect((await call(app, admin, 'POST', `/shop/devices/${device.id}/revoke`, {})).statusCode).toBe(403);
    // CSRF
    const noCsrf = { ...owner, csrf: 'bogus' };
    expect((await call(app, noCsrf, 'POST', '/shop/devices/pairing-codes', {})).json().error.code).toBe('CSRF_INVALID');
    expect((await patch(owner, device.id, { name: 'x' }, false)).statusCode).toBe(403);
    expect((await call(app, noCsrf, 'POST', `/shop/devices/${device.id}/revoke`, {})).statusCode).toBe(403);
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: device.id } })).status).toBe('ACTIVE');
    // device bearer credential does not open owner routes
    const viaBearer = await app.inject({ method: 'GET', url: '/api/v1/shop/devices', headers: auth });
    expect(viaBearer.statusCode).toBe(401);
  });
});

describe('device authentication probes', () => {
  it('rejects missing, malformed, unknown and wrong-prefix credentials identically', async () => {
    const statuses = await Promise.all(
      [{}, { authorization: 'Bearer' }, { authorization: 'Bearer pbd_' + 'a'.repeat(43) }, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }, { authorization: 'Bearer pbd_' + 'a'.repeat(500) }].map(
        async (h) => (await app.inject({ method: 'GET', url: '/probe', headers: h })).json().error.code
      )
    );
    expect(new Set(statuses)).toEqual(new Set(['UNAUTHORIZED']));
  });

  it('suspended shop devices are blocked by the guard', async () => {
    const { auth } = await seedDevice(prisma, world.a.shopId);
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    expect((await probe(auth)).statusCode).toBe(403);
  });

  it('deleting a shop cascades devices and pairing codes', async () => {
    await seedDevice(prisma, world.b.shopId);
    await prisma.devicePairingCode.create({ data: { shopId: world.b.shopId, codeHash: 'h'.repeat(64), expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.shop.delete({ where: { id: world.b.shopId } });
    expect(await prisma.shopDevice.count({ where: { shopId: world.b.shopId } })).toBe(0);
    expect(await prisma.devicePairingCode.count({ where: { shopId: world.b.shopId } })).toBe(0);
  });
});
