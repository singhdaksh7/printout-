import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_OUTSTANDING_PAIRING_CODES, pairingClientKey } from '../src/domain/devices.js';
import { testPrisma } from './helpers/db.js';
import { buildApp, call, login, seedWorld, type Session, type World } from './api-helpers.js';

const prisma = testPrisma();
let world: World;
let app: FastifyInstance;
let owner: Session;

beforeEach(async () => {
  world = await seedWorld(prisma);
  ({ app } = buildApp({ TRUST_PROXY: 'true' }));
  owner = await login(app, world.a.ownerEmail);
});
afterEach(async () => {
  await app.close();
});

const pairFrom = (ip: string, code: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/device/pair',
    headers: { 'x-forwarded-for': ip },
    payload: { code, deviceName: 'Counter tablet', platform: 'ANDROID' }
  });
const newCode = async () => (await call(app, owner, 'POST', '/shop/devices/pairing-codes', {})).json().data.code as string;

describe('pairing DoS regression (global failure ceiling must not lock every shop out)', () => {
  it('two cheap attacker IPs burning 200+ failures cannot block a legitimate pairing from another IP', async () => {
    const code = await newCode();
    const statuses: number[] = [];
    for (let i = 0; i < 100; i++) {
      statuses.push((await pairFrom('203.0.113.1', 'PB-AAAA-BBBB')).statusCode);
      statuses.push((await pairFrom('203.0.113.2', 'PB-CCCC-DDDD')).statusCode);
    }
    // the attackers themselves are throttled after a handful of failures (400 -> 429)
    expect(statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(2 * 10);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(180);
    const ok = await pairFrom('198.51.100.7', code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.deviceCredential).toMatch(/^pbd_/);
  }, 60_000);

  it('an attacker IP that is throttled cannot redeem even a valid code (guessers are stopped, fail closed per client)', async () => {
    const code = await newCode();
    for (let i = 0; i < 12; i++) await pairFrom('203.0.113.9', 'PB-AAAA-BBBB');
    expect((await pairFrom('203.0.113.9', code)).statusCode).toBe(429);
    expect(await prisma.shopDevice.count()).toBe(0);
    expect((await pairFrom('198.51.100.8', code)).statusCode).toBe(200); // code is still unused and usable from elsewhere
  });

  it('a real distributed attack (hundreds of distinct clients) still trips the global ceiling and fails closed', async () => {
    const code = await newCode();
    // 250 distinct clients x 5 failures = 1250 counted failures > 1000
    for (let c = 0; c < 250; c++) {
      for (let k = 0; k < 5; k++) {
        const r = await pairFrom(`10.${Math.floor(c / 250)}.${Math.floor(c / 25) % 10}.${(c % 25) + 1}`, 'PB-AAAA-BBBB');
        expect([400, 429]).toContain(r.statusCode);
      }
    }
    expect((await pairFrom('192.0.2.200', code)).statusCode).toBe(429);
    expect(await prisma.shopDevice.count()).toBe(0);
  }, 120_000);

  it('IPv6 addresses are throttled by /64 so an attacker cannot rotate the interface id', () => {
    expect(pairingClientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(pairingClientKey('2001:db8:1:2:1:2:3:4'));
    expect(pairingClientKey('2001:db8:1:2::1')).toBe(pairingClientKey('2001:db8:1:2::ffff'));
    expect(pairingClientKey('2001:db8:1:3::1')).not.toBe(pairingClientKey('2001:db8:1:2::1'));
    expect(pairingClientKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(pairingClientKey('203.0.113.5')).toBe('203.0.113.5');
  });
});

describe('pairing code cap is race-free', () => {
  it('15 concurrent code creations yield at most MAX_OUTSTANDING_PAIRING_CODES active codes (rest 409), never an error', async () => {
    const results = await Promise.all(Array.from({ length: 15 }, () => call(app, owner, 'POST', '/shop/devices/pairing-codes', {})));
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(MAX_OUTSTANDING_PAIRING_CODES);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(15 - MAX_OUTSTANDING_PAIRING_CODES);
    expect(await prisma.devicePairingCode.count({ where: { shopId: world.a.shopId } })).toBe(MAX_OUTSTANDING_PAIRING_CODES);
  });
});
