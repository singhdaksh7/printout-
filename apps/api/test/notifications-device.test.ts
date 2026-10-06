import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DeviceNotifier } from '../src/notifications/device-notifier.js';
import { toSafeSignal } from '../src/notifications/provider.js';
import { RecordingPushProvider } from '../src/notifications/providers.js';
import { newOrder, seedDevice, seedWorld, testConfig, type World } from './api-helpers.js';
import { testPrisma } from './helpers/db.js';

const tok = (n: string) => `fcm-${n}-` + 'q'.repeat(40);

let app: FastifyInstance;
let prisma: PrismaClient;
let world: World;
let provider: RecordingPushProvider;
let notifier: DeviceNotifier;
const logs: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  prisma = testPrisma();
  world = await seedWorld(prisma);
  provider = new RecordingPushProvider();
  logs.length = 0;
  notifier = new DeviceNotifier(prisma, provider, { warn: (o) => void logs.push(o) });
  app = createApp({ config: testConfig(), prisma, notifier }).app;
});
afterEach(async () => {
  await app.close();
});

async function withToken(shopId: string, opts: Parameters<typeof seedDevice>[2], token: string | null) {
  const d = await seedDevice(prisma, shopId, opts);
  if (token) await prisma.shopDevice.update({ where: { id: d.device.id }, data: { pushToken: token } });
  return d;
}

describe('payload guard', () => {
  it('accepts exactly {type, orderId} and rejects anything extra or malformed', () => {
    expect(toSafeSignal({ type: 'NEW_PRINT_REQUEST', orderId: 'abcdefgh12' })).toEqual({ type: 'NEW_PRINT_REQUEST', orderId: 'abcdefgh12' });
    expect(() => toSafeSignal({ type: 'NEW_PRINT_REQUEST', orderId: 'abcdefgh12', url: 'https://x' })).toThrow();
    expect(() => toSafeSignal({ type: 'NEW_PRINT_REQUEST', orderId: 'abcdefgh12', objectKey: 'k' })).toThrow();
    expect(() => toSafeSignal({ type: 'NEW_PRINT_REQUEST', orderId: 'https://evil.example/x' })).toThrow();
    expect(() => toSafeSignal({ type: 'OTHER', orderId: 'abcdefgh12' })).toThrow();
  });
});

describe('order creation notifies devices', () => {
  it('sends exactly one signal per active ANDROID device with a token of that shop only', async () => {
    const good1 = await withToken(world.a.shopId, {}, tok('g1'));
    const good2 = await withToken(world.a.shopId, {}, tok('g2'));
    await withToken(world.a.shopId, { status: 'REVOKED' }, tok('revoked'));
    await withToken(world.a.shopId, { platform: 'WINDOWS' }, tok('win'));
    await withToken(world.a.shopId, {}, null);
    await withToken(world.b.shopId, {}, tok('other'));
    expect(good1.device.id).not.toBe(good2.device.id);

    const { order } = await newOrder(app, prisma, world.a);
    await notifier.flush();
    expect(provider.sent.map((s) => s.token).sort()).toEqual([tok('g1'), tok('g2')].sort());
    for (const s of provider.sent) {
      expect(s.payload).toEqual({ type: 'NEW_PRINT_REQUEST', orderId: order.id });
    }
    const wire = JSON.stringify(provider.sent.map((s) => s.payload)).toLowerCase();
    expect(wire).not.toContain('http');
    expect(wire).not.toContain('objectkey');
    expect(wire).not.toContain('notes.pdf');
    expect(wire).not.toContain('pbd_');
  });

  it('does not notify devices of a suspended shop subscription', async () => {
    await withToken(world.a.shopId, {}, tok('sub'));
    await prisma.subscription.updateMany({ where: { shopId: world.a.shopId }, data: { status: 'SUSPENDED' } });
    notifier.notifyNewPrintRequest(world.a.shopId, 'order-abcdef12');
    await notifier.flush();
    expect(provider.sent).toHaveLength(0);
  });

  it('a throwing or failing provider never breaks order creation or leaks the token into logs', async () => {
    await withToken(world.a.shopId, {}, tok('boom'));
    provider.mode = 'throw';
    const { order } = await newOrder(app, prisma, world.a);
    await notifier.flush();
    expect(await prisma.order.findUnique({ where: { id: order.id } })).not.toBeNull();
    expect(provider.sent).toHaveLength(1);
    expect(notifier.stats.errors).toBe(1);
    expect(JSON.stringify(logs)).not.toContain('boom');
    expect(JSON.stringify(logs)).not.toContain(tok('boom'));
    provider.mode = 'fail';
    await newOrder(app, prisma, world.a);
    await notifier.flush();
    expect(notifier.stats.failed).toBe(1);
  });

  it('a notifier that throws synchronously cannot fail the customer response', async () => {
    await app.close();
    const bad = { notifyNewPrintRequest: () => { throw new Error('sync boom'); } };
    app = createApp({ config: testConfig(), prisma, notifier: bad }).app;
    const { order } = await newOrder(app, prisma, world.a);
    expect(order.id).toBeTruthy();
  });

  it('clears a token the provider reports invalid (only that device)', async () => {
    const dead = await withToken(world.a.shopId, {}, tok('dead'));
    const live = await withToken(world.a.shopId, {}, tok('live'));
    provider.invalidTokens.add(tok('dead'));
    await newOrder(app, prisma, world.a);
    await notifier.flush();
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: dead.device.id } })).pushToken).toBeNull();
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: live.device.id } })).pushToken).toBe(tok('live'));
    expect(notifier.stats.invalidTokensCleared).toBe(1);
  });

  it('survives database errors in the notifier', async () => {
    const broken = new DeviceNotifier({ shopDevice: { findMany: () => Promise.reject(new Error('db down')) } } as never, provider, {
      warn: (o) => void logs.push(o)
    });
    expect(() => broken.notifyNewPrintRequest(world.a.shopId, 'order-abcdef12')).not.toThrow();
    await broken.flush();
    expect(broken.stats.errors).toBe(1);
  });
});
