import { DocumentStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateObjectKey } from '../src/storage/keys.js';
import { advance, buildApp, call, login, newOrder, seedWorld, type Session, type World } from './api-helpers.js';

describe('Print Now (NEW -> ACCEPTED -> PRINTING) and Save File', () => {
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

  const printNow = (s: Session | null, id: string) => call(app, s, 'POST', `/shop/orders/${id}/print-now`, { clientRequestId: randomUUID() });
  const access = (s: Session | null, id: string) => call(app, s, 'POST', `/shop/orders/${id}/document-access`, {});
  const download = (s: Session | null, id: string) => call(app, s, 'POST', `/shop/orders/${id}/document-download`, {});
  const confirm = (s: Session, id: string) => call(app, s, 'POST', `/shop/orders/${id}/print-confirmation`, { clientRequestId: randomUUID() });
  const edges = async (orderId: string) =>
    (await prisma.orderStatusHistory.findMany({ where: { orderId, fromStatus: { not: null } }, orderBy: { createdAt: 'asc' } })).map((h) => `${h.fromStatus}->${h.toStatus}`);
  const doc = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });

  // ---------------- Print Now ----------------
  it('1+2. NEW + Print Now ends in PRINTING with valid NEW->ACCEPTED->PRINTING history, audit and inline access', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const res = await printNow(a, order.id);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.order.status).toBe('PRINTING');
    expect(d.transitioned).toBe(true);
    expect(d.access.contentDisposition).toBe('inline');
    expect(typeof d.access.url).toBe('string');
    expect(await edges(order.id)).toEqual(['NEW->ACCEPTED', 'ACCEPTED->PRINTING']);
    const hist = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id, fromStatus: { not: null } } });
    expect(hist.every((h) => h.reason === 'Print Now' && h.actorUserId === a.userId)).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { targetId: order.id } });
    expect(audits.filter((x) => x.action === 'order.transition' && (x.metadata as { via?: string }).via === 'print-now')).toHaveLength(2);
    expect(audits.some((x) => x.action === 'order.printNow')).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PRINTING');
  });

  it('3. another shop cannot Print Now (404, nothing changes, no URL)', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const res = await printNow(b, order.id);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toMatch(/https?:\/\/|url/i);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
    expect(await edges(order.id)).toEqual([]);
  });

  it('4. PLATFORM_ADMIN and anonymous cannot Print Now, view or save a document', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    for (const fn of [printNow, access, download]) {
      const r = await fn(admin, order.id);
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toMatch(/https?:\/\//);
      expect((await fn(null, order.id)).statusCode).toBe(401);
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
  });

  it('5. double click / retry: concurrent and repeated Print Now never duplicate transitions or history', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const [r1, r2] = await Promise.all([printNow(a, order.id), printNow(a, order.id)]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    expect(r1.json().data.order.status).toBe('PRINTING');
    expect(r2.json().data.order.status).toBe('PRINTING');
    expect(await edges(order.id)).toEqual(['NEW->ACCEPTED', 'ACCEPTED->PRINTING']);
    const third = await printNow(a, order.id);
    expect(third.statusCode).toBe(200);
    expect(third.json().data.transitioned).toBe(false);
    expect(await edges(order.id)).toEqual(['NEW->ACCEPTED', 'ACCEPTED->PRINTING']);
  });

  it('6. ACCEPTED + Print Now -> PRINTING with exactly one new transition', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    await advance(app, a, order.id, 'ACCEPTED');
    const res = await printNow(a, order.id);
    expect(res.json().data.order.status).toBe('PRINTING');
    expect(res.json().data.transitioned).toBe(true);
    expect(await edges(order.id)).toEqual(['NEW->ACCEPTED', 'ACCEPTED->PRINTING']);
  });

  it('7. PRINTING + Print Now safely re-opens the document without any transition', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    await advance(app, a, order.id, 'ACCEPTED', 'PRINTING');
    const before = await edges(order.id);
    const res = await printNow(a, order.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ transitioned: false, order: { status: 'PRINTING' }, access: { contentDisposition: 'inline' } });
    expect(await edges(order.id)).toEqual(before);
  });

  it('8+9. Print Now never sets printedAt/deleteAfter, never marks PRINTED and leaves the document AVAILABLE', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await printNow(a, order.id);
    await printNow(a, order.id);
    const d = await doc(d0.id);
    expect(d.printedAt).toBeNull();
    expect(d.deleteAfter).toBeNull();
    expect(d.status).toBe(DocumentStatus.AVAILABLE);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PRINTING');
  });

  it('10+11. Confirm Printed still sets printedAt and deleteAfter = +retention; reprint, Print Now and Save File never change them', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await printNow(a, order.id);
    const res = await confirm(a, order.id);
    expect(res.statusCode).toBe(200);
    const printedAt = new Date(res.json().data.document.printedAt).getTime();
    const deleteAfter = new Date(res.json().data.document.deleteAfter).getTime();
    expect(deleteAfter - printedAt).toBe(config.PRINT_RETENTION_MINUTES * 60_000);
    const snap = await doc(d0.id);

    expect((await access(a, order.id)).statusCode).toBe(200); // reprint
    expect((await download(a, order.id)).statusCode).toBe(200); // save file
    const again = await printNow(a, order.id); // PRINTED: Print Now is not offered
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVALID_STATUS_TRANSITION');
    const after = await doc(d0.id);
    expect(after.printedAt?.getTime()).toBe(snap.printedAt?.getTime());
    expect(after.deleteAfter?.getTime()).toBe(snap.deleteAfter?.getTime());
    expect(after.status).toBe(DocumentStatus.PRINTED_RETENTION);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PRINTED');
  });

  it('12. deleted, expired and cancelled documents cannot be printed (409, order untouched); access/save are 410', async () => {
    const deleted = await newOrder(app, prisma, world.a);
    await prisma.document.update({ where: { id: deleted.doc.id }, data: { status: DocumentStatus.DELETED, deletedAt: new Date() } });
    const expired = await newOrder(app, prisma, world.a);
    await prisma.document.update({ where: { id: expired.doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const cancelled = await newOrder(app, prisma, world.a);
    await advance(app, a, cancelled.order.id, 'CANCELLED');
    for (const o of [deleted, expired, cancelled]) {
      const r = await printNow(a, o.order.id);
      expect(r.statusCode).toBe(409);
      expect((await access(a, o.order.id)).statusCode).toBe(410);
      expect((await download(a, o.order.id)).statusCode).toBe(410);
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: deleted.order.id } })).status).toBe('NEW');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: expired.order.id } })).status).toBe('NEW');
    expect(await edges(deleted.order.id)).toEqual([]);
    expect(await edges(expired.order.id)).toEqual([]);
  });

  it('atomicity: if the access URL cannot be produced the order stays NEW with no history', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const spy = vi.spyOn(storage, 'temporaryReadUrl').mockRejectedValueOnce(new Error('storage down'));
    const res = await printNow(a, order.id);
    spy.mockRestore();
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
    expect(await edges(order.id)).toEqual([]);
    expect((await printNow(a, order.id)).statusCode).toBe(200); // retry works
  });

  it('validation: body is strict and requires a UUID clientRequestId', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    expect((await call(app, a, 'POST', `/shop/orders/${order.id}/print-now`, {})).statusCode).toBe(400);
    expect((await call(app, a, 'POST', `/shop/orders/${order.id}/print-now`, { clientRequestId: randomUUID(), shopId: world.b.shopId })).statusCode).toBe(400);
  });

  it('13. SSE: print-now emits status events to the owning shop only', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const sink = (into: string[]) => ({ write: (c: string) => { const m = /event: (.+)\n/.exec(c); if (m) into.push(m[1]!); }, close: () => undefined });
    const ua = events.subscribe(world.a.shopId, sink(seenA));
    const ub = events.subscribe(world.b.shopId, sink(seenB));
    const { order } = await newOrder(app, prisma, world.a);
    seenA.length = 0; seenB.length = 0;
    await printNow(a, order.id);
    ua(); ub();
    expect(seenA).toEqual(expect.arrayContaining(['order.statusChanged', 'order.updated']));
    expect(seenB).toEqual([]);
  });

  // ---------------- Save File ----------------
  it('Save File 1: owner gets an ATTACHMENT url with the safe original filename; Print Now stays inline', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await prisma.document.update({ where: { id: d0.id }, data: { originalFilename: 'Q3 report "final".pdf' } });
    const dl = await download(a, order.id);
    expect(dl.statusCode).toBe(200);
    expect(dl.json().data).toMatchObject({ contentDisposition: 'attachment', fileName: 'Q3 report _final_.pdf', mimeType: 'application/pdf' });
    expect(dl.json().data.url).toContain('dl=1');
    const view = await access(a, order.id);
    expect(view.json().data.contentDisposition).toBe('inline');
    expect(view.json().data.url).not.toContain('dl=1');
    expect((await printNow(a, order.id)).json().data.access.url).not.toContain('dl=1');
    expect(dl.body).not.toMatch(/objectKey|storageKey/i);
    // the opaque id only ever appears inside the signed, short-lived url itself (as with document-access), never as its own field
    const { url: _signedUrl, ...rest } = dl.json().data;
    expect(JSON.stringify(rest)).not.toContain(d0.objectKey);
  });

  it('Save File 2: another shop is denied (404, no URL)', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const r = await download(b, order.id);
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toMatch(/https?:\/\/|dl=1/);
    expect(await prisma.auditLog.count({ where: { action: 'document.download' } })).toBe(0);
  });

  it('Save File 6-8: never changes printedAt, deleteAfter, status or the retention deadline', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    // unprinted
    const u0 = await doc(d0.id);
    await download(a, order.id);
    const u1 = await doc(d0.id);
    expect([u1.printedAt, u1.deleteAfter, u1.status, u1.expiresAt?.getTime()]).toEqual([u0.printedAt, u0.deleteAfter, u0.status, u0.expiresAt?.getTime()]);
    // printed
    await advance(app, a, order.id, 'ACCEPTED', 'PRINTING');
    await confirm(a, order.id);
    const p0 = await doc(d0.id);
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 3; i++) expect((await download(a, order.id)).statusCode).toBe(200);
    const p1 = await doc(d0.id);
    expect(p1.printedAt?.getTime()).toBe(p0.printedAt?.getTime());
    expect(p1.deleteAfter?.getTime()).toBe(p0.deleteAfter?.getTime());
    expect(p1.deleteAfter!.getTime() - p1.printedAt!.getTime()).toBe(config.PRINT_RETENTION_MINUTES * 60_000);
    expect(p1.status).toBe(DocumentStatus.PRINTED_RETENTION);
  });

  it('Save File: after deleteAfter the download is denied immediately (even before the worker runs)', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await advance(app, a, order.id, 'ACCEPTED', 'PRINTING');
    await confirm(a, order.id);
    await prisma.document.update({ where: { id: d0.id }, data: { deleteAfter: new Date(Date.now() - 1000) } });
    const r = await download(a, order.id);
    expect(r.statusCode).toBe(410);
    expect(r.body).not.toMatch(/https?:\/\//);
  });

  it('Save File 10-12: the served bytes differ only by disposition (inline vs attachment), filename is sanitised, never cached, links are not interchangeable', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    const key = generateObjectKey();
    await storage.put(key, Readable.from([Buffer.from('%PDF-1.4 save file test')]), { maxBytes: 1024, contentType: 'application/pdf' });
    await prisma.document.update({ where: { id: d0.id }, data: { objectKey: key, originalFilename: 'Q3 report "final".pdf' } });
    const path = (url: string) => { const u = new URL(url, 'http://x'); return u.pathname + u.search; };

    const inline = await app.inject({ method: 'GET', url: path((await access(a, order.id)).json().data.url) });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
    expect(inline.headers['cache-control']).toMatch(/no-store/);

    const dlUrl = (await download(a, order.id)).json().data.url as string;
    const file = await app.inject({ method: 'GET', url: path(dlUrl) });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="Q3 report _final_\.pdf"/);
    expect(file.headers['cache-control']).toMatch(/no-store/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.body).toBe(inline.body);

    // the signature covers the disposition: inline links cannot be turned into downloads and vice versa
    const inlineUrl = path((await access(a, order.id)).json().data.url);
    expect((await app.inject({ method: 'GET', url: inlineUrl + '&dl=1' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: path(dlUrl).replace('&dl=1', '') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: path(dlUrl).replace(/sig=[0-9a-f]/, 'sig=0') })).statusCode).toBe(403);
  });

  it('Save File 13: the explicit save is audited without any sensitive data', async () => {
    const { order, doc: d0 } = await newOrder(app, prisma, world.a);
    await download(a, order.id);
    await access(a, order.id);
    const rows = await prisma.auditLog.findMany({ where: { targetId: order.id, action: { in: ['document.download', 'document.access'] } } });
    const dl = rows.filter((r) => r.action === 'document.download');
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ shopId: world.a.shopId, actorUserId: a.userId, targetType: 'order' });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(d0.objectKey);
    expect(text).not.toMatch(/notes\.pdf|X-Amz|sig=|exp=|https?:\/\/|AKIA|secret/i);
  });
});
