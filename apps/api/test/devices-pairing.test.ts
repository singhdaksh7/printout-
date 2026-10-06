import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { deviceGuard } from '../src/device-auth.js';
import { normalizePairingCode, PairingAttemptCeiling } from '../src/domain/devices.js';
import { testPrisma } from './helpers/db.js';
import { buildApp, call, login, seedWorld, testConfig, type Session, type World } from './api-helpers.js';

const prisma = testPrisma();
let world: World;
let app: FastifyInstance | undefined;
let owner: Session;

beforeEach(async () => {
  world = await seedWorld(prisma);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const pair = (a: FastifyInstance, code: string, extra: Record<string, unknown> = {}) =>
  a.inject({
    method: 'POST',
    url: '/api/v1/device/pair',
    payload: { code, deviceName: 'Counter tablet', platform: 'ANDROID', ...extra }
  });

async function newCode(a: FastifyInstance, s: Session): Promise<string> {
  const res = await call(a, s, 'POST', '/shop/devices/pairing-codes', {});
  expect(res.statusCode).toBe(200);
  return res.json().data.code as string;
}

async function setup(overrides: Record<string, string> = {}) {
  ({ app } = buildApp(overrides));
  owner = await login(app, world.a.ownerEmail);
  return app;
}

describe('pairing code lifecycle', () => {
  it('creates PB-XXXX-XXXX codes, redeems once, returns a one-time credential', async () => {
    const a = await setup();
    const res = await call(a, owner, 'POST', '/shop/devices/pairing-codes', {});
    const { code, expiresAt } = res.json().data;
    expect(code).toMatch(/^PB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);

    const ok = await pair(a, code.toLowerCase().replace(/-/g, ' '), { appVersion: '1.0.0', osVersion: 'Android 14' });
    expect(ok.statusCode).toBe(200);
    const body = ok.json().data;
    expect(body.deviceCredential).toMatch(/^pbd_[A-Za-z0-9_-]{43}$/);
    expect(body.shop).toEqual({ displayName: 'Sharma Print' });
    expect(body.heartbeatIntervalSeconds).toBe(60);
    const device = await prisma.shopDevice.findUniqueOrThrow({ where: { id: body.deviceId } });
    expect(device.shopId).toBe(world.a.shopId);
    expect(device.status).toBe('ACTIVE');
    const row = await prisma.devicePairingCode.findFirstOrThrow({ where: { shopId: world.a.shopId } });
    expect(row.usedByDeviceId).toBe(device.id);
    expect(row.usedAt).not.toBeNull();

    // single use
    const again = await pair(a, code);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('PAIRING_CODE_INVALID');
    expect(await prisma.shopDevice.count()).toBe(1);
  });

  it('expired, used, unknown and malformed codes all produce the IDENTICAL response', async () => {
    const a = await setup();
    const expired = await newCode(a, owner);
    await prisma.devicePairingCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const used = await newCode(a, owner);
    expect((await pair(a, used)).statusCode).toBe(200);
    const results = await Promise.all([pair(a, expired), pair(a, used), pair(a, 'PB-ZZZZ-2222'), pair(a, 'garbage'), pair(a, 'PB-0OIl-1111')]);
    const shapes = results.map((r) => ({ s: r.statusCode, c: r.json().error.code, m: r.json().error.message }));
    for (const s of shapes) expect(s).toEqual({ s: 400, c: 'PAIRING_CODE_INVALID', m: shapes[0]!.m });
    expect(await prisma.shopDevice.count()).toBe(1);
  });

  it('concurrent double redemption yields exactly one device', async () => {
    const a = await setup();
    const code = await newCode(a, owner);
    const results = await Promise.all(Array.from({ length: 8 }, () => pair(a, code)));

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(7);
    expect(await prisma.shopDevice.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'device.paired' } })).toBe(1);
  });

  it('shop comes from the code, never the body (extra shopId rejected)', async () => {
    const a = await setup();
    const code = await newCode(a, owner);
    const res = await pair(a, code, { shopId: world.b.shopId });
    expect(res.statusCode).toBe(400);
    expect(await prisma.shopDevice.count()).toBe(0);
    const ok = await pair(a, code);
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: ok.json().data.deviceId } })).shopId).toBe(world.a.shopId);
  });

  it('validates device fields', async () => {
    const a = await setup();
    const code = await newCode(a, owner);
    for (const bad of [{ deviceName: '' }, { deviceName: 'x'.repeat(61) }, { platform: 'IOS' }, { appVersion: 'x'.repeat(41) }, { osVersion: 'x'.repeat(81) }]) {
      expect((await pair(a, code, bad)).statusCode).toBe(400);
    }
    expect((await pair(a, code)).statusCode).toBe(200); // code survived the validation failures
  });

  it('refuses pairing for a suspended shop or inactive subscription with the generic error, leaving the code unused', async () => {
    const a = await setup();
    const code = await newCode(a, owner);
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    const res = await pair(a, code);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PAIRING_CODE_INVALID');
    expect(await prisma.shopDevice.count()).toBe(0);
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'ACTIVE' } });
    await prisma.subscription.update({ where: { shopId: world.a.shopId }, data: { status: 'SUSPENDED' } });
    expect((await pair(a, code)).statusCode).toBe(400);
    await prisma.subscription.update({ where: { shopId: world.a.shopId }, data: { status: 'ACTIVE' } });
    expect((await pair(a, code)).statusCode).toBe(200);
  });

  it('caps outstanding codes per shop (409) without invalidating older ones; other shops unaffected', async () => {
    const a = await setup();
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push(await newCode(a, owner));
    const sixth = await call(a, owner, 'POST', '/shop/devices/pairing-codes', {});
    expect(sixth.statusCode).toBe(409);
    expect((await pair(a, codes[0]!)).statusCode).toBe(200);
    expect((await call(a, owner, 'POST', '/shop/devices/pairing-codes', {})).statusCode).toBe(200);
    const ownerB = await login(a, world.b.ownerEmail);
    expect((await call(a, ownerB, 'POST', '/shop/devices/pairing-codes', {})).statusCode).toBe(200);
  });

  it('every pairing code row expires per DEVICE_PAIRING_TTL_MINUTES', async () => {
    const a = await setup({ DEVICE_PAIRING_TTL_MINUTES: '2' });
    await newCode(a, owner);
    const row = await prisma.devicePairingCode.findFirstOrThrow();
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttl).toBeGreaterThan(110_000);
    expect(ttl).toBeLessThanOrEqual(121_000);
  });

  it('unique credentials per device', async () => {
    const a = await setup();
    const creds = new Set<string>();
    for (let i = 0; i < 3; i++) creds.add((await pair(a, await newCode(a, owner))).json().data.deviceCredential);
    expect(creds.size).toBe(3);
    expect(new Set((await prisma.shopDevice.findMany()).map((d) => d.credentialHash)).size).toBe(3);
  });

  it('normalizes input leniently but strictly', () => {
    expect(normalizePairingCode('pb-abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' PB ABCD EFGH ')).toBe('ABCDEFGH');
    expect(normalizePairingCode('ABCDEFGH')).toBe('ABCDEFGH');
    expect(normalizePairingCode('PB-ABC-EFGH')).toBeNull();
    expect(normalizePairingCode('PB-ABCI-EFGH')).toBeNull(); // I not in alphabet
  });
});

describe('pairing abuse limits', () => {
  it('per-IP limiter returns 429', async () => {
    const a = await setup({ RATE_LIMIT_DEVICE_PAIR_MAX: '3' });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await pair(a, 'PB-AAAA-BBBB')).statusCode);
    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('global ceiling unit: only distinct clients can trip it; one client is capped and blocked individually', () => {
    const c = new PairingAttemptCeiling(3, 1000, 1, 2);
    expect(c.blocked(0, 'a')).toBe(false);
    c.recordFailure(0, 'a');
    c.recordFailure(1, 'a'); // capped: does not count globally again
    expect(c.blocked(2, 'b')).toBe(false);
    expect(c.blocked(2, 'a')).toBe(true); // client a hit its own block threshold
    c.recordFailure(3, 'b');
    c.recordFailure(4, 'c');
    expect(c.blocked(5, 'd')).toBe(true); // 3 distinct clients reached the global ceiling
    expect(c.blocked(1500, 'd')).toBe(false); // window slides
  });
});

describe('secrets never persisted or logged', () => {
  it('raw code and raw credential are not in the DB, audit metadata, or request logs', async () => {
    let logged = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logged += chunk.toString();
        cb();
      }
    });
    ({ app } = { app: createApp({ config: testConfig({ NODE_ENV: 'development' }), prisma, logStream: stream }).app });
    app.register(async (i) => {
      i.get('/probe', { preHandler: deviceGuard({ prisma, config: testConfig() } as never) }, async () => ({ ok: true }));
    });
    owner = await login(app, world.a.ownerEmail);
    const code = await newCode(app, owner);
    const body = normalizePairingCode(code)!;
    const paired = await pair(app, code);
    const secret = paired.json().data.deviceCredential as string;
    const failed = await pair(app, 'PB-WRNG-CODE');
    expect(failed.statusCode).toBe(400);
    // authenticated request with the credential, so the authorization header passes through the logger
    expect((await app.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${secret}` } })).statusCode).toBe(200);

    const dump = JSON.stringify([
      await prisma.devicePairingCode.findMany(),
      await prisma.shopDevice.findMany(),
      await prisma.auditLog.findMany()
    ]);
    for (const needle of [code, body, secret, secret.slice(4)]) {
      expect(dump).not.toContain(needle);
      expect(logged).not.toContain(needle);
    }
    expect(logged).toContain('incoming request');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'device.paired' } });
    expect(log.actorType).toBe('SHOP_DEVICE');
    expect(log.actorDeviceId).toBe(paired.json().data.deviceId);
    expect(log.metadata).toEqual({ platform: 'ANDROID' });
    expect(await prisma.auditLog.count({ where: { action: 'device.pairingCreated', actorType: 'SHOP_OWNER' } })).toBe(1);
    const stored = await prisma.shopDevice.findFirstOrThrow();
    expect(stored.credentialHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
