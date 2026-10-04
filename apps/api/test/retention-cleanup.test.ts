import { DocumentStatus, OrderStatus } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupExpiredDocuments } from '../src/cleanup.js';
import { resetDb, testPrisma } from './helpers/db.js';
import { FailingStorage, FlakyStorage, LyingStorage, MemoryStorage, makeDocument, makeOrder, makeShop, minutes } from './helpers/retention.js';

const prisma = testPrisma();
const T0 = new Date('2026-10-04T12:00:00.000Z');
let shopId: string;
let storage: MemoryStorage;

beforeEach(async () => {
  await resetDb(prisma);
  storage = new MemoryStorage();
  shopId = (await makeShop(prisma)).id;
});

const printed = () =>
  makeDocument(prisma, storage, shopId, { status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30) });

describe('printed retention', () => {
  it('retains a printed document before deleteAfter', async () => {
    const doc = await printed();
    const r = await cleanupExpiredDocuments(prisma, storage, { now: new Date(minutes(T0, 30).getTime() - 1) });
    expect(r.scanned).toBe(0);
    expect(storage.objects.has(doc.objectKey)).toBe(true);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(DocumentStatus.PRINTED_RETENTION);
  });

  it.each([30, 45])('deletes at/after deleteAfter (+%d min) and keeps order + history', async (offset) => {
    const doc = await printed();
    const order = await makeOrder(prisma, shopId, doc.id, OrderStatus.PRINTED);
    const now = minutes(T0, offset);
    const r = await cleanupExpiredDocuments(prisma, storage, { now });
    expect(r).toMatchObject({ scanned: 1, deleted: 1, failed: 0, errors: [] });
    const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe(DocumentStatus.DELETED);
    expect(after.deletedAt).toEqual(now);
    expect(after.printedAt).toEqual(T0);
    expect(after.deleteAfter).toEqual(minutes(T0, 30));
    expect(storage.objects.has(doc.objectKey)).toBe(false);
    const kept = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { histories: true } });
    expect(kept.status).toBe(OrderStatus.PRINTED);
    expect(kept.histories.length).toBe(1);
    // the order still advances independently of the deleted document
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.READY } });
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.COLLECTED } });
    const audit = await prisma.auditLog.findMany({ where: { action: 'document.deleted' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toEqual({ reason: 'print_retention' });
  });

  it('is idempotent: a second run is a no-op', async () => {
    await printed();
    await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 31) });
    const again = await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 32) });
    expect(again).toMatchObject({ scanned: 0, deleted: 0, alreadyMissing: 0, failed: 0 });
    expect(await prisma.auditLog.count({ where: { action: 'document.deleted' } })).toBe(1);
  });

  it('treats an already missing object as success', async () => {
    await makeDocument(prisma, storage, shopId, {
      status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30), withObject: false
    });
    const r = await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 30) });
    expect(r).toMatchObject({ scanned: 1, deleted: 0, alreadyMissing: 1, failed: 0 });
    expect(await prisma.document.count({ where: { status: DocumentStatus.DELETED } })).toBe(1);
  });
});

describe('storage failures', () => {
  it('does not mark DELETED, records a safe error, and retries after recovery', async () => {
    const flaky = new FlakyStorage();
    const doc = await makeDocument(prisma, flaky, shopId, {
      status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30)
    });
    const r = await cleanupExpiredDocuments(prisma, flaky, { now: minutes(T0, 31) });
    expect(r.failed).toBe(1);
    expect(r.errors).toEqual([{ documentId: doc.id, code: 'STORAGE_DELETE_FAILED' }]);
    const row = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.status).toBe(DocumentStatus.PRINTED_RETENTION);
    expect(row.deletedAt).toBeNull();
    expect(row.deletionError).toBe('STORAGE_DELETE_FAILED');
    expect(flaky.objects.has(doc.objectKey)).toBe(true);

    flaky.healthy = true;
    const retry = await cleanupExpiredDocuments(prisma, flaky, { now: minutes(T0, 32) });
    expect(retry.deleted).toBe(1);
    const healed = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(healed.status).toBe(DocumentStatus.DELETED);
    expect(healed.deletionError).toBeNull();
  });

  it('never leaks paths or credentials into deletionError', async () => {
    const failing = new FailingStorage();
    const doc = await makeDocument(prisma, failing, shopId, {
      status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30)
    });
    await cleanupExpiredDocuments(prisma, failing, { now: minutes(T0, 30) });
    const row = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.deletionError).toBeTruthy();
    expect(row.deletionError).not.toMatch(/secret|AKIA|\//);
  });

  it('does not mark DELETED when the object is still present after delete', async () => {
    const lying = new LyingStorage();
    const doc = await makeDocument(prisma, lying, shopId, {
      status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30)
    });
    const r = await cleanupExpiredDocuments(prisma, lying, { now: minutes(T0, 30) });
    expect(r.errors[0]).toEqual({ documentId: doc.id, code: 'STORAGE_VERIFY_FAILED' });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(DocumentStatus.PRINTED_RETENTION);
  });
});

describe('unprinted expiry', () => {
  it('deletes AVAILABLE documents at expiresAt, including orphans without an order', async () => {
    const expired = await makeDocument(prisma, storage, shopId, { uploadedAt: T0, expiresAt: minutes(T0, 24 * 60) });
    const fresh = await makeDocument(prisma, storage, shopId, { uploadedAt: T0, expiresAt: minutes(T0, 24 * 60 + 1) });
    expect((await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 24 * 60 - 1) })).scanned).toBe(0);
    const r = await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 24 * 60) });
    expect(r.deleted).toBe(1);
    expect(storage.objects.has(expired.objectKey)).toBe(false);
    expect(storage.objects.has(fresh.objectKey)).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'document.deleted' } });
    expect(audit.metadata).toEqual({ reason: 'unprinted_expiry' });
  });

  it.each([OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PRINTING])('expires a %s order with history + audit', async (status) => {
    const doc = await makeDocument(prisma, storage, shopId, { uploadedAt: T0, expiresAt: minutes(T0, 1440) });
    const order = await makeOrder(prisma, shopId, doc.id, status);
    const events: { shopId: string; event: string }[] = [];
    const r = await cleanupExpiredDocuments(prisma, storage, {
      now: minutes(T0, 1441),
      events: { emit: (s, e) => { events.push({ shopId: s, event: e }); } }
    });
    expect(r.ordersExpired).toBe(1);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { histories: { orderBy: { createdAt: 'asc' } } } });
    expect(row.status).toBe(OrderStatus.EXPIRED);
    expect(row.histories.at(-1)).toMatchObject({ fromStatus: status, toStatus: OrderStatus.EXPIRED, actorUserId: null, reason: 'document_expired' });
    expect(await prisma.auditLog.count({ where: { action: 'order.expired', targetId: order.id } })).toBe(1);
    expect(events.map((e) => e.event).sort()).toEqual(['document.deleted', 'order.statusChanged']);
    expect(events.every((e) => e.shopId === shopId)).toBe(true);
  });

  it.each([OrderStatus.PRINTED, OrderStatus.READY, OrderStatus.COLLECTED, OrderStatus.CANCELLED])('leaves a %s order alone', async (status) => {
    const doc = await makeDocument(prisma, storage, shopId, { uploadedAt: T0, expiresAt: minutes(T0, 1440) });
    const order = await makeOrder(prisma, shopId, doc.id, status);
    await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 1441) });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(status);
  });

  it('a throwing events subscriber does not break cleanup', async () => {
    await makeDocument(prisma, storage, shopId, { uploadedAt: T0, expiresAt: T0 });
    const r = await cleanupExpiredDocuments(prisma, storage, { now: T0, events: { emit: () => { throw new Error('boom'); } } });
    expect(r.deleted).toBe(1);
  });
});

describe('stale uploads', () => {
  it('sweeps UPLOADING and FAILED documents past the stale age or expiry, not fresh ones', async () => {
    const stale = await makeDocument(prisma, storage, shopId, { status: DocumentStatus.UPLOADING, createdAt: minutes(T0, -61) });
    const failed = await makeDocument(prisma, storage, shopId, { status: DocumentStatus.FAILED, createdAt: minutes(T0, -120) });
    const expiredUploading = await makeDocument(prisma, storage, shopId, {
      status: DocumentStatus.UPLOADING, createdAt: minutes(T0, -5), expiresAt: minutes(T0, -1)
    });
    const fresh = await makeDocument(prisma, storage, shopId, { status: DocumentStatus.UPLOADING, createdAt: minutes(T0, -10) });
    const r = await cleanupExpiredDocuments(prisma, storage, { now: T0 });
    expect(r.scanned).toBe(3);
    for (const d of [stale, failed, expiredUploading]) {
      expect((await prisma.document.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(DocumentStatus.DELETED);
      expect(storage.objects.has(d.objectKey)).toBe(false);
    }
    expect((await prisma.document.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe(DocumentStatus.UPLOADING);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { targetId: stale.id } })).metadata).toEqual({ reason: 'stale_upload' });
  });

  it('honours a custom stale age', async () => {
    await makeDocument(prisma, storage, shopId, { status: DocumentStatus.UPLOADING, createdAt: minutes(T0, -10) });
    const r = await cleanupExpiredDocuments(prisma, storage, { now: T0, staleUploadMinutes: 5 });
    expect(r.deleted).toBe(1);
  });
});

describe('concurrency and volume', () => {
  it('two concurrent runs do not error and write exactly one audit row per document', async () => {
    for (let i = 0; i < 20; i++) await printed();
    const [a, b] = await Promise.all([
      cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 31), batchSize: 7 }),
      cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 31), batchSize: 7 })
    ]);
    expect(a.failed + b.failed).toBe(0);
    expect(a.deleted + a.alreadyMissing + b.deleted + b.alreadyMissing).toBe(20);
    expect(await prisma.document.count({ where: { status: DocumentStatus.DELETED } })).toBe(20);
    expect(await prisma.auditLog.count({ where: { action: 'document.deleted' } })).toBe(20);
    expect(storage.objects.size).toBe(0);
  });

  it('processes 250 documents across batches', async () => {
    await prisma.document.createMany({
      data: Array.from({ length: 250 }, (_, i) => {
        const objectKey = `bulk-${i}`;
        storage.put(objectKey);
        return { shopId, objectKey, originalFilename: 'x.pdf', status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30) };
      })
    });
    const r = await cleanupExpiredDocuments(prisma, storage, { now: minutes(T0, 30), batchSize: 100 });
    expect(r).toMatchObject({ scanned: 250, deleted: 250, failed: 0 });
    expect(storage.objects.size).toBe(0);
  });

  it('failed documents do not loop forever within a run', async () => {
    const flaky = new FlakyStorage();
    for (let i = 0; i < 5; i++) {
      await makeDocument(prisma, flaky, shopId, { status: DocumentStatus.PRINTED_RETENTION, printedAt: T0, deleteAfter: minutes(T0, 30) });
    }
    const r = await cleanupExpiredDocuments(prisma, flaky, { now: minutes(T0, 30), batchSize: 2 });
    expect(r).toMatchObject({ scanned: 5, failed: 5 });
  });
});

describe('recheck of deleted documents', () => {
  it('removes an object that reappeared for a DELETED document when enabled', async () => {
    const doc = await makeDocument(prisma, storage, shopId, { status: DocumentStatus.DELETED, deletedAt: minutes(T0, -5) });
    expect((await cleanupExpiredDocuments(prisma, storage, { now: T0 })).scanned).toBe(0);
    expect(storage.objects.has(doc.objectKey)).toBe(true);
    await cleanupExpiredDocuments(prisma, storage, { now: T0, recheckDeleted: true });
    expect(storage.objects.has(doc.objectKey)).toBe(false);
  });
});
