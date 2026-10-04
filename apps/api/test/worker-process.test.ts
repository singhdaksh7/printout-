import { DocumentStatus, type PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { startWorker } from '../src/worker.js';
import { resetDb, testPrisma } from './helpers/db.js';
import { MemoryStorage, makeDocument, makeShop, minutes } from './helpers/retention.js';

const prisma = testPrisma();
const T0 = new Date('2026-10-04T12:00:00.000Z');
const silent = {};

beforeEach(() => resetDb(prisma));

describe('startWorker', () => {
  it('--once runs a single cleanup and stops', async () => {
    const storage = new MemoryStorage();
    const shop = await makeShop(prisma);
    const doc = await makeDocument(prisma, storage, shop.id, {
      status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30)
    });
    const worker = startWorker({ prisma, storage, argv: ['--once'], now: () => minutes(T0, 30), log: silent });
    await worker.done;
    expect(worker.runs).toHaveLength(1);
    expect(worker.runs[0]!.deleted).toBe(1);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(DocumentStatus.DELETED);
  });

  it('WORKER_RUN_ONCE=1 behaves like --once', async () => {
    const worker = startWorker({ prisma, storage: new MemoryStorage(), env: { ...process.env, WORKER_RUN_ONCE: '1' }, argv: [], log: silent });
    await worker.done;
    expect(worker.runs).toHaveLength(1);
  });

  it('polls on an interval, never overlaps, and stops gracefully', async () => {
    let active = 0;
    let maxActive = 0;
    const storage = new MemoryStorage();
    const baseExists = storage.exists.bind(storage);
    storage.exists = async (k) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return baseExists(k);
    };
    const shop = await makeShop(prisma);
    await makeDocument(prisma, storage, shop.id, { status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30) });
    await makeDocument(prisma, storage, shop.id, { status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 3000) });
    const worker = startWorker({ prisma, storage, argv: [], intervalMs: 10, now: () => minutes(T0, 31), log: silent });
    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();
    expect(worker.runs.length).toBeGreaterThan(1);
    expect(maxActive).toBe(1);
  });

  it('survives a failing run and keeps going', async () => {
    const broken = { delete: async () => undefined, exists: async () => false };
    const failingPrisma = new Proxy(prisma, {
      get: (target, prop, receiver) =>
        prop === 'document'
          ? { findMany: async () => { throw new Error('db down'); } }
          : Reflect.get(target, prop, receiver)
    }) as unknown as PrismaClient;
    const logged: string[] = [];
    const worker = startWorker({
      prisma: failingPrisma, storage: broken, argv: [], intervalMs: 10,
      log: { error: (_o, m) => { logged.push(m ?? ''); } }
    });
    await new Promise((r) => setTimeout(r, 120));
    await worker.stop();
    expect(logged.length).toBeGreaterThan(1);
  });
});
