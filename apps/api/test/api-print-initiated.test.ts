import { DocumentStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupExpiredDocuments } from '../src/cleanup.js';
import { advance, buildApp, call, login, newOrder, seedLegacyStatus, seedWorld, type Session, type World } from './api-helpers.js';
import { FlakyStorage, MemoryStorage } from './helpers/retention.js';

/**
 * Retention rule: the FIRST successful shop Print starts the 30-minute window (printInitiatedAt, deleteAfter = +30 min).
 * Upload alone never does. Reprint / Save File / reopen / retries never move either timestamp.
 */
describe('print-initiated retention', () => {
  const { app, prisma, events, storage, config } = buildApp();
  let world: World;
  let a: Session;
  let b: Session;
  let admin: Session;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    a = await login(app, world.a.ownerEmail);
    b = await login(app, world.b.ownerEmail);
    admin = await login(app, world.adminEmail);
  });

  const RET = () => config.PRINT_RETENTION_MINUTES * 60_000;
  const printNow = (s: Session | null, id: string) => call(app, s, 'POST', `/shop/orders/${id}/print-now`, { clientRequestId: randomUUID() });
  const access = (s: Session | null, id: string) => call(app, s, 'POST', `/shop/orders/${id}/document-access`, {});
  const download = (s: Session | null, id: string) => call(app, s, 'POST', `/shop/orders/${id}/document-download`, {});
  const doc = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
  const stamps = (d: { printInitiatedAt: Date | null; printedAt: Date | null; deleteAfter: Date | null; status: string }) => ({
    pi: d.printInitiatedAt?.getTime() ?? null,
    pr: d.printedAt?.getTime() ?? null,
    da: d.deleteAfter?.getTime() ?? null,
    status: d.status
  });

  it('1. upload alone does not start the 30-minute window (and viewing details / the queue does not either)', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    const d = await doc(d0.id);
    expect(d.status).toBe(DocumentStatus.AVAILABLE);
    expect(d.printInitiatedAt).toBeNull();
    expect(d.printedAt).toBeNull();
    expect(d.deleteAfter).toBeNull();
    expect((await call(app, a, 'GET', `/shop/orders/${order.id}`)).statusCode).toBe(200);
    expect((await call(app, a, 'GET', '/shop/orders')).statusCode).toBe(200);
    expect(stamps(await doc(d0.id))).toEqual(stamps(d));
  });

  it('2. unprinted upload keeps the 24-hour rule: retained before expiresAt, deleted from storage after it', async () => {
    const { doc: d0 } = await newOrder(app, prisma, world.a);
    const d = await doc(d0.id);
    const hours = (d.expiresAt!.getTime() - (d.uploadedAt ?? d.createdAt).getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(config.UNPRINTED_RETENTION_HOURS);
    const mem = new MemoryStorage();
    mem.put(d.objectKey);
    const early = await cleanupExpiredDocuments(prisma, mem, { now: new Date(d.expiresAt!.getTime() - 60_000) });
    expect(early.deleted).toBe(0);
    expect(mem.objects.has(d.objectKey)).toBe(true);
    const late = await cleanupExpiredDocuments(prisma, mem, { now: new Date(d.expiresAt!.getTime() + 1000) });
    expect(late.deleted).toBe(1);
    expect(mem.objects.has(d.objectKey)).toBe(false);
    expect((await doc(d0.id)).status).toBe(DocumentStatus.DELETED);
  });

  it('3+4+5. first Print sets printInitiatedAt server-side, deleteAfter is exactly +retention, and inline access is immediate and servable', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    const before = Date.now();
    const res = await printNow(a, order.id);
    const after = Date.now();
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.firstPrint).toBe(true);
    expect(data.order.status).toBe('PRINTING');
    expect(data.access).toMatchObject({ contentDisposition: 'inline', mimeType: 'application/pdf' });
    const d = await doc(d0.id);
    expect(d.printInitiatedAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(d.printInitiatedAt!.getTime()).toBeLessThanOrEqual(after + 5);
    expect(d.deleteAfter!.getTime() - d.printInitiatedAt!.getTime()).toBe(RET());
    expect(d.printedAt).toBeNull(); // Print does not claim a physical print happened
    expect(d.status).toBe(DocumentStatus.PRINTED_RETENTION);
    expect(new Date(data.document.printInitiatedAt).getTime()).toBe(d.printInitiatedAt!.getTime());
    expect(new Date(data.access.expiresAt).getTime()).toBeLessThanOrEqual(d.deleteAfter!.getTime());
    expect(await prisma.auditLog.count({ where: { targetId: order.id, action: 'order.printInitiated' } })).toBe(1);
    // the order is NOT marked PRINTED (no physical-print claim)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PRINTING');
  });

  it('6-9. the shop never needs Accept / Start Printing / Confirm / Ready / Collected: one Print from NEW is enough', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    expect((await printNow(a, order.id)).statusCode).toBe(200);
    const hist = (await prisma.orderStatusHistory.findMany({ where: { orderId: order.id, fromStatus: { not: null } }, orderBy: { createdAt: 'asc' } })).map(
      (h) => `${h.fromStatus}->${h.toStatus}`
    );
    expect(hist).toEqual(['NEW->ACCEPTED', 'ACCEPTED->PRINTING']);
    expect((await access(a, order.id)).statusCode).toBe(200); // reprint with no further lifecycle action
  });

  it('10. double click / concurrent Print: exactly one winner, timestamps never reset', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    const rs = await Promise.all([printNow(a, order.id), printNow(a, order.id), printNow(a, order.id)]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(rs.filter((r) => r.json().data.firstPrint === true)).toHaveLength(1);
    const first = await doc(d0.id);
    await new Promise((r) => setTimeout(r, 1100));
    const later = await printNow(a, order.id);
    expect(later.json().data.firstPrint).toBe(false);
    expect(stamps(await doc(d0.id))).toEqual(stamps(first));
    expect(await prisma.auditLog.count({ where: { targetId: order.id, action: 'order.printInitiated' } })).toBe(1);
  });

  it('11+12+13. Reprint, Save File and reopen never move printInitiatedAt or deleteAfter', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await printNow(a, order.id);
    const snap = await doc(d0.id);
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 2; i++) {
      expect((await printNow(a, order.id)).statusCode).toBe(200); // Reprint
      expect((await access(a, order.id)).statusCode).toBe(200); // reopen
      expect((await download(a, order.id)).statusCode).toBe(200); // Save File
      expect((await call(app, a, 'GET', `/shop/orders/${order.id}`)).statusCode).toBe(200); // details
    }
    expect(stamps(await doc(d0.id))).toEqual(stamps(snap));
  });

  it('14. a Print that fails before access can be provided does NOT start retention, and a retry then does', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    const before = stamps(await doc(d0.id));
    const spy = vi.spyOn(storage, 'temporaryReadUrl').mockRejectedValueOnce(new Error('storage down'));
    const failed = await printNow(a, order.id);
    spy.mockRestore();
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(stamps(await doc(d0.id))).toEqual(before);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
    const ok = await printNow(a, order.id);
    expect(ok.json().data.firstPrint).toBe(true);
    expect((await doc(d0.id)).deleteAfter).not.toBeNull();
  });

  it('14b. a Print that is refused (cancelled / expired / deleted document) starts nothing', async () => {
    const cancelled = await newOrder(app, prisma, world.a);
    await advance(app, a, cancelled.order.id, 'CANCELLED');
    const expired = await newOrder(app, prisma, world.a);
    await prisma.document.update({ where: { id: expired.doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    for (const o of [cancelled, expired]) {
      const before = stamps(await doc(o.doc.id));
      expect((await printNow(a, o.order.id)).statusCode).toBe(409);
      expect(stamps(await doc(o.doc.id))).toEqual(before);
      expect((await doc(o.doc.id)).printInitiatedAt).toBeNull();
    }
  });

  it('15. at deleteAfter, access / Save File / Print are denied immediately (410/409) even before the worker runs', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await printNow(a, order.id);
    await prisma.document.update({ where: { id: d0.id }, data: { deleteAfter: new Date(Date.now() - 1000) } });
    for (const fn of [access, download]) {
      const r = await fn(a, order.id);
      expect(r.statusCode).toBe(410);
      expect(r.body).not.toMatch(/https?:\/\//);
    }
    expect((await printNow(a, order.id)).statusCode).toBe(409);
  });

  it('16+17. the worker physically deletes the object, and DB becomes DELETED only after storage deletion succeeds', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await printNow(a, order.id);
    const d = await doc(d0.id);
    const flaky = new FlakyStorage();
    flaky.put(d.objectKey);
    const due = new Date(d.deleteAfter!.getTime() + 1000);

    const early = await cleanupExpiredDocuments(prisma, flaky, { now: new Date(d.deleteAfter!.getTime() - 60_000) });
    expect(early.scanned).toBe(0); // not due yet: untouched
    expect(flaky.objects.has(d.objectKey)).toBe(true);

    const failed = await cleanupExpiredDocuments(prisma, flaky, { now: due }); // storage down
    expect(failed).toMatchObject({ failed: 1, deleted: 0 });
    expect(flaky.objects.has(d.objectKey)).toBe(true);
    expect((await doc(d0.id)).status).toBe(DocumentStatus.PRINTED_RETENTION); // NOT falsely DELETED

    flaky.healthy = true;
    const ok = await cleanupExpiredDocuments(prisma, flaky, { now: due });
    expect(ok).toMatchObject({ deleted: 1, failed: 0 });
    expect(flaky.objects.has(d.objectKey)).toBe(false);
    const after = await doc(d0.id);
    expect(after.status).toBe(DocumentStatus.DELETED);
    // order metadata survives deletion; a print-initiated order is not retroactively expired
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PRINTING');
  });

  it('16b. an already-missing object is handled safely (idempotent) and the document is marked DELETED', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await printNow(a, order.id);
    const d = await doc(d0.id);
    const mem = new MemoryStorage(); // object was never there / already removed
    const r = await cleanupExpiredDocuments(prisma, mem, { now: new Date(d.deleteAfter!.getTime() + 1000) });
    expect(r).toMatchObject({ alreadyMissing: 1, failed: 0 });
    expect((await doc(d0.id)).status).toBe(DocumentStatus.DELETED);
  });

  it('18. another shop cannot Print / Reprint / Save, and nothing changes', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    const before = stamps(await doc(d0.id));
    for (const fn of [printNow, access, download]) {
      const r = await fn(b, order.id);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toMatch(/https?:\/\/|url/i);
    }
    expect(stamps(await doc(d0.id))).toEqual(before);
    await printNow(a, order.id);
    const printed = stamps(await doc(d0.id));
    for (const fn of [printNow, access, download]) expect((await fn(b, order.id)).statusCode).toBe(404);
    expect(stamps(await doc(d0.id))).toEqual(printed);
  });

  it('19. PLATFORM_ADMIN cannot print or access the document, before or after Print', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    await printNow(a, order.id);
    for (const fn of [printNow, access, download]) {
      const r = await fn(admin, order.id);
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toMatch(/https?:\/\//);
    }
    const list = await call(app, admin, 'GET', '/admin/orders');
    expect(list.body).not.toMatch(/originalFilename|objectKey/);
  });

  it('20. SSE stays tenant-isolated: first Print emits deletionScheduled to the owning shop only, a reprint emits nothing', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const sink = (into: string[]) => ({ write: (c: string) => { const m = /event: (.+)\n/.exec(c); if (m) into.push(m[1]!); }, close: () => undefined });
    const ua = events.subscribe(world.a.shopId, sink(seenA));
    const ub = events.subscribe(world.b.shopId, sink(seenB));
    const { order } = await newOrder(app, prisma, world.a);
    seenA.length = 0; seenB.length = 0;
    await printNow(a, order.id);
    expect(seenA).toEqual(expect.arrayContaining(['order.statusChanged', 'document.deletionScheduled']));
    seenA.length = 0;
    await printNow(a, order.id);
    expect(seenA).toEqual([]);
    ua(); ub();
    expect(seenB).toEqual([]);
  });

  it('queue filter: print=pending is the NEW queue, print=initiated is Recent; ids never leak across shops', async () => {
    const o1 = await newOrder(app, prisma, world.a);
    const o2 = await newOrder(app, prisma, world.a);
    const other = await newOrder(app, prisma, world.b);
    await printNow(a, o2.order.id);
    const ids = async (q: string, s: Session) => (await call(app, s, 'GET', `/shop/orders?${q}`)).json().data.items.map((i: { id: string }) => i.id);
    expect(await ids('print=pending', a)).toEqual([o1.order.id]);
    expect(await ids('print=initiated', a)).toEqual([o2.order.id]);
    expect(await ids('print=initiated', b)).toEqual([]);
    expect(await ids('print=pending', b)).toEqual([other.order.id]);
    const item = (await call(app, a, 'GET', '/shop/orders?print=initiated')).json().data.items[0];
    expect(item.printInitiatedAt).toBeTruthy();
    expect(item.deleteAfter).toBeTruthy();
  });

  it('existing documents: a legacy confirmed document keeps its deleteAfter untouched; an unprinted legacy PRINTING order starts 30 minutes on its first Print', async () => {
    const legacy = await newOrder(app, prisma, world.a);
    const legacyUnprinted = await newOrder(app, prisma, world.a);
    await advance(app, a, legacyUnprinted.order.id, 'ACCEPTED', 'PRINTING');
    // legacy confirmation (old flow, now retired): printedAt + deleteAfter set directly, no printInitiatedAt
    await seedLegacyStatus(prisma, legacy.order.id, 'PRINTED', { retentionMinutes: RET() / 60_000 });
    const retired = await call(app, a, 'POST', `/shop/orders/${legacy.order.id}/print-confirmation`, { clientRequestId: randomUUID() });
    expect(retired.statusCode).toBe(410);
    const snap = await doc(legacy.doc.id);
    expect(snap.printInitiatedAt).toBeNull();
    expect(snap.deleteAfter!.getTime() - snap.printedAt!.getTime()).toBe(RET());
    await new Promise((r) => setTimeout(r, 1100));
    expect((await printNow(a, legacy.order.id)).statusCode).toBe(200); // reprint inside the old window
    expect(stamps(await doc(legacy.doc.id))).toEqual(stamps(snap));
    // unprinted legacy doc was on the 24 h rule until Print
    expect((await doc(legacyUnprinted.doc.id)).deleteAfter).toBeNull();
    expect((await printNow(a, legacyUnprinted.order.id)).json().data.firstPrint).toBe(true);
    const d = await doc(legacyUnprinted.doc.id);
    expect(d.deleteAfter!.getTime() - d.printInitiatedAt!.getTime()).toBe(RET());
  });
});
