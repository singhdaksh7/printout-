import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupExpiredDocuments } from '../src/cleanup.js';
import { MemoryStorage } from './helpers/retention.js';
import {
  advance,
  buildApp,
  call,
  createDocument,
  login,
  newOrder,
  quoteFor,
  seedLegacyStatus,
  placeOrder,
  seedWorld,
  type Session,
  type World
} from './api-helpers.js';

describe('order lifecycle', () => {
  const { app, prisma, events, config } = buildApp();
  let world: World;
  let s: Session;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    s = await login(app, world.a.ownerEmail);
  });


  const transition = (orderId: string, toStatus: string) =>
    call(app, s, 'POST', `/shop/orders/${orderId}/transitions`, { toStatus, clientRequestId: randomUUID() });
  const confirm = (orderId: string) =>
    call(app, s, 'POST', `/shop/orders/${orderId}/print-confirmation`, { clientRequestId: randomUUID() });
  const printNow = (orderId: string) =>
    call(app, s, 'POST', `/shop/orders/${orderId}/print-now`, { clientRequestId: randomUUID() });

  it('new flow: print-now takes NEW -> ACCEPTED -> PRINTING with history, audit logs and SSE events', async () => {
    const seen: Array<{ event: string; data: string }> = [];
    const unsub = events.subscribe(world.a.shopId, {
      write: (chunk) => {
        const m = /event: (.+)\ndata: (.+)\n/.exec(chunk);
        if (m) seen.push({ event: m[1]!, data: m[2]! });
      },
      close: () => undefined
    });
    const { order } = await newOrder(app, prisma, world.a);

    const before = Date.now();
    const res = await printNow(order.id);
    const after = Date.now();
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.order.status).toBe('PRINTING');
    expect(data.document.status).toBe('PRINTED_RETENTION');
    const initiated = new Date(data.document.printInitiatedAt).getTime();
    expect(initiated).toBeGreaterThanOrEqual(before - 1);
    expect(initiated).toBeLessThanOrEqual(after + 1);
    expect(new Date(data.document.deleteAfter).getTime() - initiated).toBe(config.PRINT_RETENTION_MINUTES * 60_000);

    const detail = (await call(app, s, 'GET', `/shop/orders/${order.id}`)).json().data;
    expect(detail.order.status).toBe('PRINTING');
    expect(detail.statusHistory.map((h: { toStatus: string }) => h.toStatus)).toEqual(['NEW', 'ACCEPTED', 'PRINTING']);
    expect(detail.order).toMatchObject({ originalFilename: 'notes.pdf', selectedPageCount: 10, orderNumber: 'SHARMA-0001' });
    expect(detail.document.deletionState).toBe('OK');
    const row = await prisma.document.findUniqueOrThrow({ where: { id: order.documentId } });
    expect(row.printedAt).toBeNull();

    const actions = (await prisma.auditLog.findMany({ where: { shopId: world.a.shopId } })).map((a) => a.action);
    expect(actions).toContain('order.printInitiated');
    expect(actions).not.toContain('order.printConfirmed');
    expect(actions.filter((a) => a === 'order.transition')).toHaveLength(2);

    const names = seen.map((e) => e.event);
    expect(names).toContain('order.created');
    expect(names).toContain('order.statusChanged');
    expect(names).toContain('order.updated');
    expect(names).toContain('document.deletionScheduled');
    // Minimal payloads: no urls / storage keys.
    for (const e of seen) {
      expect(e.data).not.toMatch(/objectKey|url|test-/);
    }
    unsub();
  });

  it('transitions accepts ONLY CANCELLED: every other toStatus is a 400 VALIDATION_ERROR and changes nothing', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    for (const to of ['NEW', 'ACCEPTED', 'PRINTING', 'PRINTED', 'READY', 'COLLECTED', 'EXPIRED']) {
      const r = await transition(order.id, to);
      expect(r.statusCode, `-> ${to}`).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
    // also from a PRINTING order
    await printNow(order.id);
    for (const to of ['PRINTED', 'READY', 'EXPIRED', 'ACCEPTED']) {
      expect((await transition(order.id, to)).statusCode, `PRINTING -> ${to}`).toBe(400);
    }
    // PRINTING cannot be cancelled either
    expect((await transition(order.id, 'CANCELLED')).statusCode).toBe(409);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { document: true } });
    expect(row.status).toBe('PRINTING');
    expect(row.document.printedAt).toBeNull();
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(3);
  });

  it('applies cancellation rules and terminal states', async () => {
    const a = await newOrder(app, prisma, world.a);
    expect((await transition(a.order.id, 'CANCELLED')).statusCode).toBe(200);
    for (const to of ['ACCEPTED', 'PRINTING', 'NEW']) expect((await transition(a.order.id, to)).statusCode).toBe(400);
    const b = await newOrder(app, prisma, world.a);
    await advance(app, s, b.order.id, 'ACCEPTED'); // legacy ACCEPTED row can still be cancelled
    expect((await transition(b.order.id, 'CANCELLED')).statusCode).toBe(200);
    // Legacy printed / ready / collected orders can never be cancelled.
    for (const st of ['PRINTED', 'READY', 'COLLECTED'] as const) {
      const c = await newOrder(app, prisma, world.a);
      await seedLegacyStatus(prisma, c.order.id, st);
      expect((await transition(c.order.id, 'CANCELLED')).statusCode, st).toBe(409);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: c.order.id } })).status).toBe(st);
    }
  });

  it('cancel retries are harmless no-ops (idempotent, history not duplicated)', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    expect((await transition(order.id, 'CANCELLED')).statusCode).toBe(200);
    expect((await transition(order.id, 'CANCELLED')).statusCode).toBe(200);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'order.transition', targetId: order.id } })).toBe(1);
  });

  it('transitions still validates body: CSRF, strict body, missing clientRequestId', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const url = `/shop/orders/${order.id}/transitions`;
    expect((await call(app, s, 'POST', url, { toStatus: 'CANCELLED' })).statusCode).toBe(400);
    expect((await call(app, s, 'POST', url, { toStatus: 'CANCELLED', clientRequestId: randomUUID(), extra: 1 })).statusCode).toBe(400);
    expect((await call(app, s, 'POST', url, { toStatus: 'CANCELLED', clientRequestId: randomUUID() }, { headers: { 'x-csrf-token': 'wrong' } })).statusCode).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
  });

  it('print-confirmation is RETIRED: always 410 ENDPOINT_RETIRED and changes nothing', async () => {
    const { order, doc } = await newOrder(app, prisma, world.a);
    const snapshot = async () => ({
      order: await prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      doc: await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }),
      history: await prisma.orderStatusHistory.count({ where: { orderId: order.id } }),
      audits: await prisma.auditLog.count()
    });
    const check = async (label: string) => {
      const before = await snapshot();
      for (const body of [{ clientRequestId: randomUUID() }, {}]) {
        const r = await call(app, s, 'POST', `/shop/orders/${order.id}/print-confirmation`, body);
        expect(r.statusCode, label).toBe(410);
        expect(r.json().error.code).toBe('ENDPOINT_RETIRED');
      }
      const after = await snapshot();
      expect(after.order.status).toBe(before.order.status);
      expect(after.doc.printedAt).toEqual(before.doc.printedAt);
      expect(after.doc.printInitiatedAt).toEqual(before.doc.printInitiatedAt);
      expect(after.doc.deleteAfter).toEqual(before.doc.deleteAfter);
      expect(after.doc.status).toBe(before.doc.status);
      expect(after.history).toBe(before.history);
      expect(after.audits).toBe(before.audits);
      expect(after.doc.printedAt).toBeNull();
    };
    await check('NEW');
    await printNow(order.id);
    await check('PRINTING');
    expect(await prisma.auditLog.count({ where: { action: 'order.printConfirmed' } })).toBe(0);
  });

  it('legacy PRINTED orders: print-confirmation retired, reads keep working', async () => {
    const { order, doc } = await newOrder(app, prisma, world.a);
    await seedLegacyStatus(prisma, order.id, 'PRINTED');
    const printed = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(printed.status).toBe('PRINTED_RETENTION');
    expect((await confirm(order.id)).statusCode).toBe(410);
    const unchanged = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(unchanged.printedAt).toEqual(printed.printedAt);
    expect(unchanged.deleteAfter).toEqual(printed.deleteAfter);
    const list = (await call(app, s, 'GET', '/shop/orders')).json().data;
    expect(JSON.stringify(list)).toContain(order.id);
    expect((await call(app, s, 'GET', `/shop/orders/${order.id}`)).json().data.order.status).toBe('PRINTED');
  });

  it('expiry: the shop cannot request EXPIRED (400); an expired unprinted order is not printable', async () => {
    const live = await newOrder(app, prisma, world.a);
    expect((await transition(live.order.id, 'EXPIRED')).statusCode).toBe(400);
    await prisma.document.update({ where: { id: live.doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await transition(live.order.id, 'EXPIRED')).statusCode).toBe(400);
    const pn = await printNow(live.order.id);
    expect(pn.statusCode).toBe(409);
    expect(pn.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
    const row = await prisma.order.findUniqueOrThrow({ where: { id: live.order.id }, include: { document: true } });
    expect(row.status).toBe('NEW');
    expect(row.document.printInitiatedAt).toBeNull();
  });

  it('document-access: capped TTL, no timestamp changes on reprint, denied after deleteAfter without the worker', async () => {
    const { order, doc } = await newOrder(app, prisma, world.a);
    const access = () => call(app, s, 'POST', `/shop/orders/${order.id}/document-access`, {});
    const preview = await access(); // unprinted preview is allowed
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.contentDisposition).toBe('inline');
    expect(preview.json().data.url).toBeTruthy();
    await seedLegacyStatus(prisma, order.id, 'PRINTED'); // legacy production record
    const printed = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });

    const r1 = await access();
    const r2 = await access();
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(new Date(r1.json().data.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 300_000 + 1000);
    const unchanged = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(unchanged.printedAt).toEqual(printed.printedAt);
    expect(unchanged.deleteAfter).toEqual(printed.deleteAfter);

    // 10 seconds left: expiry capped to remaining time
    await prisma.document.update({ where: { id: doc.id }, data: { deleteAfter: new Date(Date.now() + 10_000) } });
    const capped = await access();
    expect(capped.statusCode).toBe(200);
    expect(new Date(capped.json().data.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 10_500);

    // At/after deleteAfter: denied although status is still PRINTED_RETENTION (worker has not run).
    await prisma.document.update({ where: { id: doc.id }, data: { deleteAfter: new Date(Date.now() - 1) } });
    const denied = await access();
    expect(denied.statusCode).toBe(410);
    expect(denied.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
    await prisma.document.update({ where: { id: doc.id }, data: { status: 'DELETED', deletedAt: new Date() } });
    expect((await access()).json().error.code).toBe('DOCUMENT_UNAVAILABLE');
  });

  it('legacy PRINTED/READY/COLLECTED rows list, show detail and open while retained, and are denied at deleteAfter', async () => {
    for (const st of ['PRINTED', 'READY', 'COLLECTED'] as const) {
      const { order, doc } = await newOrder(app, prisma, world.a);
      await seedLegacyStatus(prisma, order.id, st);
      const list = (await call(app, s, 'GET', '/shop/orders')).json().data;
      expect(JSON.stringify(list), st).toContain(order.id);
      const detail = (await call(app, s, 'GET', `/shop/orders/${order.id}`)).json().data;
      expect(detail.order.status).toBe(st);
      expect(detail.statusHistory.map((h: { toStatus: string }) => h.toStatus).at(-1)).toBe(st);
      const open = await call(app, s, 'POST', `/shop/orders/${order.id}/document-access`, {});
      expect(open.statusCode, st).toBe(200);
      await prisma.document.update({ where: { id: doc.id }, data: { deleteAfter: new Date(Date.now() - 1) } });
      const denied = await call(app, s, 'POST', `/shop/orders/${order.id}/document-access`, {});
      expect(denied.statusCode, st).toBe(410);
      expect(denied.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
    }
  });

  it('worker cleanup still deletes legacy PRINTED/READY/COLLECTED documents at deleteAfter and leaves earlier ones', async () => {
    const storage = new MemoryStorage();
    const rows = [];
    for (const st of ['PRINTED', 'READY', 'COLLECTED'] as const) {
      const { order, doc } = await newOrder(app, prisma, world.a);
      await seedLegacyStatus(prisma, order.id, st, { printedAt: new Date(Date.now() - 31 * 60_000), deleteAfter: new Date(Date.now() - 1000) });
      storage.put(doc.objectKey);
      rows.push({ order, doc, st });
    }
    const fresh = await newOrder(app, prisma, world.a);
    await seedLegacyStatus(prisma, fresh.order.id, 'PRINTED'); // still inside its window
    storage.put(fresh.doc.objectKey);

    const result = await cleanupExpiredDocuments(prisma, storage, { now: new Date() });
    expect(result).toMatchObject({ deleted: 3, failed: 0 });
    for (const { order, doc, st } of rows) {
      expect(storage.objects.has(doc.objectKey), st).toBe(false);
      expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('DELETED');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(st);
      expect((await call(app, s, 'POST', `/shop/orders/${order.id}/document-access`, {})).statusCode).toBe(410);
    }
    expect(storage.objects.has(fresh.doc.objectKey)).toBe(true);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: fresh.doc.id } })).status).toBe('PRINTED_RETENTION');
  });

  it('document-access is denied for cancelled orders and expired unprinted documents', async () => {
    const a = await newOrder(app, prisma, world.a);
    await transition(a.order.id, 'CANCELLED');
    expect((await call(app, s, 'POST', `/shop/orders/${a.order.id}/document-access`, {})).statusCode).toBe(410);
    const b = await newOrder(app, prisma, world.a);
    await prisma.document.update({ where: { id: b.doc.id }, data: { expiresAt: new Date(Date.now() - 5) } });
    expect((await call(app, s, 'POST', `/shop/orders/${b.order.id}/document-access`, {})).statusCode).toBe(410);
  });

  it('settings, pricing rules: explicit fields only, clean 409 on duplicates, audit logged', async () => {
    const set = await call(app, s, 'PUT', '/shop/settings', { displayName: 'Sharma Prints', address: '1 Main Rd', publicContact: 'WhatsApp 12345', brandColor: '#112233', acceptsOrders: false });
    expect(set.statusCode).toBe(200);
    expect(set.json().data).toMatchObject({ displayName: 'Sharma Prints', brandColor: '#112233', acceptsOrders: false });
    for (const bad of [{ status: 'SUSPENDED' }, { slug: 'new-slug' }, { brandColor: 'red' }, {}, { id: 'x' }]) {
      expect((await call(app, s, 'PUT', '/shop/settings', bad)).statusCode).toBe(400);
    }
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: world.a.shopId } });
    expect(shop.status).toBe('ACTIVE');
    expect(shop.slug).toBe('sharma-print');

    const dup = await call(app, s, 'POST', '/shop/pricing-rules', { colourMode: 'bw', sides: 'single', pricePerSheetPaise: 50 });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('DUPLICATE_PRICING_RULE');
    const rules = (await call(app, s, 'GET', '/shop/pricing-rules')).json().data;
    const bw = rules.find((r: { colourMode: string; sides: string }) => r.colourMode === 'bw' && r.sides === 'single');
    const bwD = rules.find((r: { colourMode: string; sides: string }) => r.colourMode === 'bw' && r.sides === 'duplex');
    expect((await call(app, s, 'PUT', `/shop/pricing-rules/${bw.id}`, { pricePerSheetPaise: 250 })).json().data.pricePerSheetPaise).toBe(250);
    expect((await call(app, s, 'PUT', `/shop/pricing-rules/${bw.id}`, { sides: 'duplex' })).statusCode).toBe(409);
    expect((await call(app, s, 'PUT', `/shop/pricing-rules/${bw.id}`, { pricePerSheetPaise: -5 })).statusCode).toBe(400);
    expect((await call(app, s, 'PUT', `/shop/pricing-rules/${bw.id}`, { shopId: world.b.shopId })).statusCode).toBe(400);
    expect((await call(app, s, 'DELETE', `/shop/pricing-rules/${bwD.id}`)).statusCode).toBe(204);
    expect((await call(app, s, 'DELETE', `/shop/pricing-rules/${bwD.id}`)).statusCode).toBe(404);
    const created = await call(app, s, 'POST', '/shop/pricing-rules', { colourMode: 'bw', sides: 'duplex', pricePerSheetPaise: 150 });
    expect(created.statusCode).toBe(201);

    const actions = (await prisma.auditLog.findMany({ where: { shopId: world.a.shopId } })).map((a) => a.action);
    for (const a of ['shop.settings.update', 'pricing.create', 'pricing.update', 'pricing.delete']) expect(actions).toContain(a);
  });

  it('analytics uses the print-initiated model: prints initiated / new requests / auto-deleted, hides internal ACCEPTED step', async () => {
    const printed = await newOrder(app, prisma, world.a);
    await newOrder(app, prisma, world.a);
    const other = await newOrder(app, prisma, world.b);
    expect((await call(app, s, 'POST', `/shop/orders/${printed.order.id}/print-now`, { clientRequestId: randomUUID() })).statusCode).toBe(200);
    await prisma.document.update({ where: { id: printed.doc.id }, data: { status: 'DELETED', deletedAt: new Date() } });
    const d = (await call(app, s, 'GET', '/shop/analytics')).json().data;
    expect(d.printsInitiated).toBe(1);
    expect(d.newPrintRequests).toBe(1);
    expect(d.documentsAutoDeleted).toBe(1);
    expect(d.printedDocumentCount).toBeUndefined();
    expect(d.recentActivity.map((a: { toStatus: string }) => a.toStatus)).not.toContain('ACCEPTED');
    expect(d.recentActivity.map((a: { toStatus: string }) => a.toStatus)).toContain('PRINTING');
    expect(other.order.id).toBeTruthy(); // another shop's orders never count
  });

  it('analytics returns dashboard data (IST today) without a "revenue" field', async () => {
    const first = await newOrder(app, prisma, world.a, { paperSize: 'A4', colourMode: 'colour', sides: 'single', copies: 2, pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 3 }] } });
    await newOrder(app, prisma, world.a);
    const cancelled = await newOrder(app, prisma, world.a);
    await transition(cancelled.order.id, 'CANCELLED');
    await newOrder(app, prisma, world.b);
    const res = await call(app, s, 'GET', '/shop/analytics');
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d).toMatchObject({
      timezone: 'Asia/Kolkata',
      ordersToday: 3,
      pagesToday: 3 * 2 + 10,
      estimatedOrderValuePaise: 3 * 2 * 1000 + 2000,
      bwCount: 1,
      colourCount: 1
    });
    expect(d.ordersByStatus).toMatchObject({ NEW: 2, CANCELLED: 1 });
    expect(d.recentActivity.length).toBeLessThanOrEqual(10);
    expect(d.recentActivity[0]).toHaveProperty('orderNumber');
    expect(JSON.stringify(d).toLowerCase()).not.toContain('revenue');
    expect(first.order.id).toBeTruthy();
    const empty = await call(app, s, 'GET', '/shop/analytics?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z');
    expect(empty.json().data.ordersToday).toBe(0);
    expect((await call(app, s, 'GET', '/shop/analytics?from=2020-01-02&to=2020-01-01')).statusCode).toBe(400);
  });

  it('qr returns the public url', async () => {
    const d = (await call(app, s, 'GET', '/shop/qr')).json().data;
    expect(d.publicUrl).toBe('http://localhost:5173/p/sharma-print');
    expect(d.slug).toBe('sharma-print');
  });

  it('keeps unused quote helpers honest', async () => {
    const doc = await createDocument(prisma, world.a.shopId);
    const q = await quoteFor(app, world.a.slug, doc.id);
    expect((await placeOrder(app, world.a.slug, q.json().data.quoteId)).statusCode).toBe(200);
  });
});
