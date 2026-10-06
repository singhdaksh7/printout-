import { DocumentStatus } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupPairingCodes } from '../src/cleanup.js';
import { startWorker } from '../src/worker.js';
import { resetDb, testPrisma } from './helpers/db.js';
import { MemoryStorage, makeDocument, makeShop, minutes } from './helpers/retention.js';

const prisma = testPrisma();
const T0 = new Date('2026-10-04T12:00:00.000Z');
const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);
let n = 0;
const code = (shopId: string, data: { expiresAt: Date; usedAt?: Date }) =>
  prisma.devicePairingCode.create({ data: { shopId, codeHash: `hash-${++n}-${Math.random()}`, ...data } });

beforeEach(() => resetDb(prisma));

describe('cleanupPairingCodes', () => {
  it('deletes codes expired/used more than 24h ago and keeps recent and active ones; never touches devices', async () => {
    const shop = await makeShop(prisma);
    const old = await code(shop.id, { expiresAt: hours(T0, -30) });
    const oldUsed = await code(shop.id, { expiresAt: hours(T0, -29), usedAt: hours(T0, -30) });
    const recent = await code(shop.id, { expiresAt: hours(T0, -2) });
    const active = await code(shop.id, { expiresAt: hours(T0, 1) });
    const device = await prisma.shopDevice.create({
      data: { shopId: shop.id, name: 'Old tablet', platform: 'ANDROID', status: 'REVOKED', credentialHash: 'x'.repeat(64), revokedAt: hours(T0, -100) }
    });
    const res = await cleanupPairingCodes(prisma, { now: T0 });
    expect(res.deleted).toBe(2);
    const left = (await prisma.devicePairingCode.findMany()).map((c) => c.id).sort();
    expect(left).toEqual([recent.id, active.id].sort());
    expect(left).not.toContain(old.id);
    expect(left).not.toContain(oldUsed.id);
    expect(await prisma.shopDevice.count({ where: { id: device.id } })).toBe(1);
  });
});

describe('worker pairing-code sweep', () => {
  it('sweeps old codes and still deletes documents', async () => {
    const storage = new MemoryStorage();
    const shop = await makeShop(prisma);
    await code(shop.id, { expiresAt: hours(T0, -48) });
    const doc = await makeDocument(prisma, storage, shop.id, { status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30) });
    const worker = startWorker({ prisma, storage, argv: ['--once'], now: () => minutes(T0, 31), log: {} });
    await worker.done;
    expect(worker.runs[0]!.deleted).toBe(1);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(DocumentStatus.DELETED);
    expect(await prisma.devicePairingCode.count()).toBe(0);
  });

  it('a failing sweep never affects document deletion', async () => {
    const storage = new MemoryStorage();
    const shop = await makeShop(prisma);
    await code(shop.id, { expiresAt: hours(T0, -48) });
    const doc = await makeDocument(prisma, storage, shop.id, { status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30) });
    const broken = new Proxy(prisma, {
      get: (target, prop, receiver) =>
        prop === 'devicePairingCode'
          ? { deleteMany: async () => { throw new Error('sweep boom'); } }
          : Reflect.get(target, prop, receiver)
    });
    const errors: string[] = [];
    const worker = startWorker({ prisma: broken, storage, argv: ['--once'], now: () => minutes(T0, 31), log: { error: (_o, msg) => void errors.push(msg ?? '') } });
    await worker.done;
    expect(worker.runs[0]!.deleted).toBe(1);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(DocumentStatus.DELETED);
    expect(errors).toContain('pairing code sweep failed');
    expect(await prisma.devicePairingCode.count()).toBe(1);
  });
});
