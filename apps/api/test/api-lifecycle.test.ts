import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  advance,
  buildApp,
  call,
  createDocument,
  login,
  newOrder,
  quoteFor,
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

  it('runs the full happy path to COLLECTED with history, audit logs and SSE events', async () => {
    const seen: Array<{ event: string; data: string }> = [];
    const unsub = events.subscribe(world.a.shopId, {
      write: (chunk) => {
        const m = /event: (.+)\ndata: (.+)\n/.exec(chunk);
        if (m) seen.push({ event: m[1]!, data: m[2]! });
      },
      close: () => undefined
    });
    const { order } = await newOrder(app, prisma, world.a);
    await advance(app, s, order.id, 'ACCEPTED', 'PRINTING');

    const before = Date.now();
    const res = await confirm(order.id);
    const after = Date.now();
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.order.status).toBe('PRINTED');
    expect(data.document.status).toBe('PRINTED_RETENTION');
    const printedAt = new Date(data.document.printedAt).getTime();
    expect(printedAt).toBeGreaterThanOrEqual(before - 1);
    expect(printedAt).toBeLessThanOrEqual(after + 1);
    expect(new Date(data.document.deleteAfter).getTime() - printedAt).toBe(config.PRINT_RETENTION_MINUTES * 60_000);

    await advance(app, s, order.id, 'READY', 'COLLECTED');
    const detail = (await call(app, s, 'GET', `/shop/orders/${order.id}`)).json().data;
    expect(detail.order.status).toBe('COLLECTED');
    expect(detail.statusHistory.map((h: { toStatus: string }) => h.toStatus)).toEqual(['NEW', 'ACCEPTED', 'PRINTING', 'PRINTED', 'READY', 'COLLECTED']);
    expect(detail.order).toMatchObject({ originalFilename: 'notes.pdf', selectedPageCount: 10, orderNumber: 'SHARMA-0001' });
    expect(detail.document.deletionState).toBe('OK');

    const actions = (await prisma.auditLog.findMany({ where: { shopId: world.a.shopId } })).map((a) => a.action);
    expect(actions).toContain('order.printConfirmed');
    expect(actions.filter((a) => a === 'order.transition')).toHaveLength(4);

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

  it('never allows PRINTED outside print-confirmation, and rejects illegal transitions', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    for (const to of ['PRINTED', 'READY', 'COLLECTED', 'PRINTING', 'EXPIRED']) {
      const r = await transition(order.id, to);
      expect(r.statusCode, `NEW -> ${to}`).toBe(409);
      expect(r.json().error.code).toBe('INVALID_STATUS_TRANSITION');
    }
    await advance(app, s, order.id, 'ACCEPTED', 'PRINTING');
    const bypass = await transition(order.id, 'PRINTED');
    expect(bypass.statusCode).toBe(409);
    expect(bypass.json().error.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await transition(order.id, 'READY')).statusCode).toBe(409);
    expect((await transition(order.id, 'CANCELLED')).statusCode).toBe(409);
    expect((await transition(order.id, 'EXPIRED')).statusCode).toBe(409); // system-only edge
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { document: true } });
    expect(row.status).toBe('PRINTING');
    expect(row.document.printedAt).toBeNull();
    expect(row.document.deleteAfter).toBeNull();
  });

  it('applies cancellation rules and terminal states', async () => {
    const a = await newOrder(app, prisma, world.a);
    expect((await transition(a.order.id, 'CANCELLED')).statusCode).toBe(200);
    for (const to of ['ACCEPTED', 'PRINTING', 'NEW']) expect((await transition(a.order.id, to)).statusCode).toBe(409);
    const b = await newOrder(app, prisma, world.a);
    await advance(app, s, b.order.id, 'ACCEPTED', 'CANCELLED');
    const c = await newOrder(app, prisma, world.a);
    await advance(app, s, c.order.id, 'ACCEPTED', 'PRINTING');
    await confirm(c.order.id);
    expect((await transition(c.order.id, 'CANCELLED')).statusCode).toBe(409);
    await advance(app, s, c.order.id, 'READY', 'COLLECTED');
    expect((await transition(c.order.id, 'READY')).statusCode).toBe(409);
  });

  it('transition retries to the same status are harmless no-ops', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    await advance(app, s, order.id, 'ACCEPTED');
    expect((await transition(order.id, 'ACCEPTED')).statusCode).toBe(200);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('print-confirmation requires PRINTING and a CSRF-protected, validated body', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    expect((await confirm(order.id)).statusCode).toBe(409);
    await advance(app, s, order.id, 'ACCEPTED');
    expect((await confirm(order.id)).statusCode).toBe(409);
    await advance(app, s, order.id, 'PRINTING');
    expect((await call(app, s, 'POST', `/shop/orders/${order.id}/print-confirmation`, {})).statusCode).toBe(400);
  });

  it('print-confirmation is idempotent: timestamps never change, even concurrently', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    await advance(app, s, order.id, 'ACCEPTED', 'PRINTING');
    const results = await Promise.all(Array.from({ length: 5 }, () => confirm(order.id)));
    for (const r of results) expect(r.statusCode).toBe(200);
    expect(new Set(results.map((r) => r.json().data.document.printedAt)).size).toBe(1);
    expect(new Set(results.map((r) => r.json().data.document.deleteAfter)).size).toBe(1);
    const first = await prisma.document.findUniqueOrThrow({ where: { id: order.documentId } });
    await new Promise((r) => setTimeout(r, 30));
    const again = await confirm(order.id);
    expect(again.json().data.document.printedAt).toBe(first.printedAt!.toISOString());
    expect(again.json().data.document.deleteAfter).toBe(first.deleteAfter!.toISOString());
    // still after the order moved on
    await advance(app, s, order.id, 'READY');
    const later = await confirm(order.id);
    expect(later.statusCode).toBe(200);
    expect(later.json().data.document.printedAt).toBe(first.printedAt!.toISOString());
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id, toStatus: 'PRINTED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'order.printConfirmed' } })).toBe(1);
  });

  it('refuses print-confirmation when the document expired or was deleted', async () => {
    const { order, doc } = await newOrder(app, prisma, world.a);
    await advance(app, s, order.id, 'ACCEPTED', 'PRINTING');
    await prisma.document.update({ where: { id: doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await confirm(order.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PRINTING');
    await prisma.document.update({ where: { id: doc.id }, data: { status: 'DELETED', deletedAt: new Date() } });
    expect((await confirm(order.id)).json().error.code).toBe('DOCUMENT_UNAVAILABLE');
  });

  it('enforces the expiry rule', async () => {
    const live = await newOrder(app, prisma, world.a);
    expect((await transition(live.order.id, 'EXPIRED')).statusCode).toBe(409);
    await prisma.document.update({ where: { id: live.doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // expired document: cannot accept, but can expire
    const accept = await transition(live.order.id, 'ACCEPTED');
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
    expect((await transition(live.order.id, 'EXPIRED')).statusCode).toBe(200);
    expect((await transition(live.order.id, 'ACCEPTED')).statusCode).toBe(409);
  });

  it('document-access: capped TTL, no timestamp changes on reprint, denied after deleteAfter without the worker', async () => {
    const { order, doc } = await newOrder(app, prisma, world.a);
    const access = () => call(app, s, 'POST', `/shop/orders/${order.id}/document-access`, {});
    const preview = await access(); // unprinted preview is allowed
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.contentDisposition).toBe('inline');
    expect(preview.json().data.url).toBeTruthy();
    await advance(app, s, order.id, 'ACCEPTED', 'PRINTING');
    await confirm(order.id);
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
