import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { call, login, newOrder, seedDevice, seedWorld, testConfig, type Session, type World } from './api-helpers.js';
import { testPrisma } from './helpers/db.js';

/**
 * Production runs the API with `connection_limit=5` (deploy/docker-compose.prod.yml). A burst of device prints must not
 * exhaust that pool and surface as 5xx (Prisma "Unable to start a transaction in the given time").
 */
describe('stress: small connection pool (connection_limit=5)', () => {
  let small: PrismaClient;
  let app: ReturnType<typeof createApp>['app'];
  let world: World;
  let owner: Session;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!.replace(/^postgresql:/, 'http:'));
    url.searchParams.set('connection_limit', '5');
    small = new PrismaClient({ datasourceUrl: url.toString().replace(/^http:/, 'postgresql:') });
    ({ app } = createApp({ config: testConfig(), prisma: small }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await small.$disconnect();
  });
  beforeEach(async () => {
    world = await seedWorld(testPrisma());
    owner = await login(app, world.a.ownerEmail);
  });

  const devPrint = (auth: Record<string, string>, id: string) =>
    app.inject({ method: 'POST', url: `/api/v1/device/orders/${id}/print`, headers: auth, payload: { clientRequestId: randomUUID() } });

  it('25 concurrent device prints across 5 devices + browser prints on ONE order: exactly one firstPrint, no 5xx', async () => {
    const devices = await Promise.all([0, 1, 2, 3, 4].map((i) => seedDevice(testPrisma(), world.a.shopId, { name: `D${i}` })));
    const o = await newOrder(app, testPrisma(), world.a);
    const calls = [
      ...Array.from({ length: 25 }, (_, i) => devPrint(devices[i % 5]!.auth, o.order.id)),
      ...Array.from({ length: 5 }, () => call(app, owner, 'POST', `/shop/orders/${o.order.id}/print-now`, { clientRequestId: randomUUID() }))
    ];
    const results = await Promise.all(calls);
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(results.filter((r) => r.json().data.firstPrint)).toHaveLength(1);
    const prisma = testPrisma();
    expect(await prisma.auditLog.count({ where: { targetId: o.order.id, action: 'order.printInitiated' } })).toBe(1);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.order.id, fromStatus: { not: null } } })).toBe(2);
    const d = await prisma.document.findUniqueOrThrow({ where: { id: o.doc.id } });
    expect(d.deleteAfter!.getTime() - d.printInitiatedAt!.getTime()).toBe(30 * 60_000);
  }, 60_000);

  it('a burst of first prints on 20 DIFFERENT orders (5 devices) never produces a 5xx and starts exactly one window each', async () => {
    const devices = await Promise.all([0, 1, 2, 3, 4].map((i) => seedDevice(testPrisma(), world.a.shopId, { name: `D${i}` })));
    const orders = [];
    for (let i = 0; i < 20; i++) orders.push(await newOrder(app, testPrisma(), world.a));
    const results = await Promise.all(orders.map((o, i) => devPrint(devices[i % 5]!.auth, o.order.id)));
    expect(results.map((r) => r.statusCode).filter((s) => s !== 200)).toEqual([]);
    expect(results.every((r) => r.json().data.firstPrint === true)).toBe(true);
  }, 60_000);

  it('a burst of concurrent pairings (valid codes) all succeed within the pool without 5xx', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const r = await call(app, owner, 'POST', '/shop/devices/pairing-codes', {});
        if (r.statusCode === 200) codes.push(r.json().data.code);
      }
      // cap is 5 outstanding per shop: stop once reached
      if (codes.length >= 5) break;
    }
    expect(codes.length).toBe(5);
    const results = await Promise.all(
      codes.map((code) => app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { code, deviceName: 'Tab', platform: 'ANDROID' } }))
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
  }, 60_000);
});
