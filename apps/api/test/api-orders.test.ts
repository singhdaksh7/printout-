import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signQuote } from '../src/domain/quote-token.js';
import { quoteSecret } from '../src/config.js';
import {
  baseOptions,
  buildApp,
  call,
  createDocument,
  login,
  newOrder,
  placeOrder,
  quoteFor,
  seedWorld,
  type World
} from './api-helpers.js';

describe('public quotes and orders', () => {
  const { app, prisma, config } = buildApp();
  let world: World;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
  });

  it('quotes server-side (duplex = physical sheets) and creates an order equal to the server calculation', async () => {
    const doc = await createDocument(prisma, world.a.shopId, { pageCount: 5 });
    const opts = { ...baseOptions, sides: 'duplex', copies: 2 };
    const q = await quoteFor(app, world.a.slug, doc.id, opts);
    expect(q.statusCode).toBe(200);
    // ceil(5/2)=3 sheets x 2 copies x 180 paise
    expect(q.json().data).toMatchObject({ selectedPageCount: 5, sheetsPerCopy: 3, totalSheets: 6, unitPricePaise: 180, totalPaise: 1080, currency: 'INR' });
    const o = await placeOrder(app, world.a.slug, q.json().data.quoteId, { customerDisplayNameOrReference: 'Ravi' });
    expect(o.statusCode).toBe(200);
    expect(o.json().data).toMatchObject({ status: 'NEW', totalPaise: 1080, currency: 'INR' });
    expect(o.json().data.orderNumber).toMatch(/^SHARMA-0001$/);
    const stored = await prisma.order.findFirstOrThrow({});
    expect(stored.totalPaise).toBe(1080);
    expect(stored.priceSnapshot).toMatchObject({ totalPaise: 1080, selectedPageCount: 5 });
  });

  it('ignores any client-supplied price fields (strict bodies)', async () => {
    const doc = await createDocument(prisma, world.a.shopId);
    const fakeOptions = await quoteFor(app, world.a.slug, doc.id, { ...baseOptions, totalPaise: 1, unitPricePaise: 1 });
    expect(fakeOptions.statusCode).toBe(400);
    const fakeBody = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/quotes`, payload: { documentId: doc.id, printOptions: baseOptions, pageCount: 1, totalPaise: 1 } });
    expect(fakeBody.statusCode).toBe(400);
    const q = await quoteFor(app, world.a.slug, doc.id);
    const o = await placeOrder(app, world.a.slug, q.json().data.quoteId, { totalPaise: 1 });
    expect(o.statusCode).toBe(400);
  });

  it('rejects forged, tampered, garbage and expired quote tokens', async () => {
    const doc = await createDocument(prisma, world.a.shopId);
    const q = (await quoteFor(app, world.a.slug, doc.id)).json().data;
    const [v, body, sig] = (q.quoteId as string).split('.') as [string, string, string];
    // Tamper the payload (cheaper options) keeping the original signature.
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.o.copies = 1;
    payload.o.colourMode = 'bw';
    payload.o.sides = 'duplex';
    const tampered = `${v}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    for (const bad of [tampered, 'garbage', `${v}.${body}.${'A'.repeat(43)}`, Buffer.from(JSON.stringify({ documentId: doc.id, result: { totalPaise: 1 }, expiresAt: Date.now() + 1e6 })).toString('base64url')]) {
      const r = await placeOrder(app, world.a.slug, bad);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('INVALID_QUOTE');
    }
    // Properly signed with the wrong secret
    const wrongSecret = signQuote('x'.repeat(40), { documentId: doc.id, shopId: world.a.shopId, printOptions: baseOptions, expiresAt: Date.now() + 60000 });
    expect((await placeOrder(app, world.a.slug, wrongSecret)).json().error.code).toBe('INVALID_QUOTE');
    // Expired but correctly signed
    const expired = signQuote(quoteSecret(config), { documentId: doc.id, shopId: world.a.shopId, printOptions: baseOptions, expiresAt: Date.now() - 1000 });
    const r = await placeOrder(app, world.a.slug, expired);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('QUOTE_EXPIRED');
    expect(await prisma.order.count()).toBe(0);
  });

  it('rejects a quote from shop A used against shop B', async () => {
    const doc = await createDocument(prisma, world.a.shopId);
    const q = (await quoteFor(app, world.a.slug, doc.id)).json().data;
    const r = await placeOrder(app, world.b.slug, q.quoteId);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('INVALID_QUOTE');
    // and a document of A cannot be quoted via B's slug
    expect((await quoteFor(app, world.b.slug, doc.id)).statusCode).toBe(422);
  });

  it('recalculates at order time using the CURRENT pricing rules', async () => {
    const doc = await createDocument(prisma, world.a.shopId, { pageCount: 4 });
    const q = (await quoteFor(app, world.a.slug, doc.id)).json().data;
    expect(q.totalPaise).toBe(800);
    await prisma.pricingRule.updateMany({ where: { shopId: world.a.shopId, colourMode: 'bw', sides: 'single' }, data: { pricePerSheetPaise: 300 } });
    const o = await placeOrder(app, world.a.slug, q.quoteId);
    expect(o.json().data.totalPaise).toBe(1200);
  });

  it('fails when the pricing rule was deactivated after quoting', async () => {
    const doc = await createDocument(prisma, world.a.shopId);
    const q = (await quoteFor(app, world.a.slug, doc.id)).json().data;
    await prisma.pricingRule.updateMany({ where: { shopId: world.a.shopId }, data: { active: false } });
    const o = await placeOrder(app, world.a.slug, q.quoteId);
    expect(o.statusCode).toBe(422);
    expect(o.json().error.code).toBe('NO_PRICING_RULE');
  });

  it('validates page ranges against the document and dedupes selected pages', async () => {
    const doc = await createDocument(prisma, world.a.shopId, { pageCount: 10 });
    const ranges = (r: unknown) => quoteFor(app, world.a.slug, doc.id, { ...baseOptions, pageSelection: { mode: 'ranges', ranges: r } });

    const ok = await ranges([{ from: 1, to: 5 }, { from: 3, to: 7 }, { from: 9, to: 9 }, { from: 9, to: 9 }]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.selectedPageCount).toBe(8); // 1-7 + 9
    expect(ok.json().data.printOptions.pageSelection.ranges).toEqual([{ from: 1, to: 7 }, { from: 9, to: 9 }]);

    for (const bad of [
      [{ from: 5, to: 3 }],
      [{ from: 1, to: 11 }],
      [{ from: 11, to: 12 }],
      [{ from: 0, to: 2 }],
      [{ from: 1, to: 1e9 }],
      [{ from: 1.5, to: 2 }],
      Array.from({ length: 51 }, () => ({ from: 1, to: 1 }))
    ]) {
      const r = await ranges(bad);
      expect([400, 422], JSON.stringify(bad).slice(0, 50)).toContain(r.statusCode);
    }
    const out = await ranges([{ from: 1, to: 11 }]);
    expect(out.json().error.code).toBe('INVALID_PAGE_RANGE');
    expect((await ranges([{ from: 5, to: 3 }])).json().error.code).toBe('INVALID_PAGE_RANGE');
    expect((await ranges([])).statusCode).toBe(400);

    const o = await placeOrder(app, world.a.slug, ok.json().data.quoteId);
    const stored = await prisma.order.findFirstOrThrow({});
    expect(stored.printOptionsSnapshot).toMatchObject({ pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 7 }, { from: 9, to: 9 }] } });
    expect(stored.totalPaise).toBe(8 * 200);
    expect(o.json().data.totalPaise).toBe(1600);
  });

  it('rejects tampered options in the quote request (colour/sides/copies/paper)', async () => {
    const doc = await createDocument(prisma, world.a.shopId);
    for (const bad of [
      { ...baseOptions, copies: 0 },
      { ...baseOptions, copies: -2 },
      { ...baseOptions, copies: 1.5 },
      { ...baseOptions, copies: 100000 },
      { ...baseOptions, colourMode: 'rainbow' },
      { ...baseOptions, sides: 'triple' },
      { ...baseOptions, paperSize: 'A3' }
    ]) {
      expect((await quoteFor(app, world.a.slug, doc.id, bad)).statusCode).toBe(400);
    }
  });

  it('one document can only produce one order (race-safe claim)', async () => {
    const doc = await createDocument(prisma, world.a.shopId);
    const q = (await quoteFor(app, world.a.slug, doc.id)).json().data;
    const results = await Promise.all(Array.from({ length: 6 }, () => placeOrder(app, world.a.slug, q.quoteId)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 200)) {
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('DOCUMENT_ALREADY_USED');
    }
    expect(await prisma.order.count()).toBe(1);
  });

  it('is idempotent on clientRequestId, including concurrent retries', async () => {
    const doc = await createDocument(prisma, world.a.shopId);
    const q = (await quoteFor(app, world.a.slug, doc.id)).json().data;
    const clientRequestId = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => placeOrder(app, world.a.slug, q.quoteId, { clientRequestId })));
    for (const r of results) expect(r.statusCode).toBe(200);
    expect(new Set(results.map((r) => r.json().data.trackingToken)).size).toBe(1);
    expect(await prisma.order.count()).toBe(1);
    // A different document with the same clientRequestId conflicts.
    const doc2 = await createDocument(prisma, world.a.shopId);
    const q2 = (await quoteFor(app, world.a.slug, doc2.id)).json().data;
    const conflict = await placeOrder(app, world.a.slug, q2.quoteId, { clientRequestId });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('generates unique, human-readable, per-shop sequential order numbers', async () => {
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) numbers.push((await newOrder(app, prisma, world.a)).order.orderNumber);
    numbers.push((await newOrder(app, prisma, world.b)).order.orderNumber);
    expect(numbers).toEqual(['SHARMA-0001', 'SHARMA-0002', 'SHARMA-0003', 'METROC-0001']);
  });

  it('concurrent orders get distinct numbers', async () => {
    const docs = await Promise.all(Array.from({ length: 6 }, () => createDocument(prisma, world.a.shopId)));
    const quotes = await Promise.all(docs.map((d) => quoteFor(app, world.a.slug, d.id)));
    const orders = await Promise.all(quotes.map((q) => placeOrder(app, world.a.slug, q.json().data.quoteId)));
    expect(orders.every((o) => o.statusCode === 200)).toBe(true);
    expect(new Set(orders.map((o) => o.json().data.orderNumber)).size).toBe(6);
  });

  it('refuses unavailable documents and suspended/closed shops', async () => {
    const expired = await createDocument(prisma, world.a.shopId, { expiresAt: new Date(Date.now() - 1000) });
    expect((await quoteFor(app, world.a.slug, expired.id)).statusCode).toBe(422);
    const deleted = await createDocument(prisma, world.a.shopId, { status: 'DELETED' });
    expect((await quoteFor(app, world.a.slug, deleted.id)).statusCode).toBe(422);

    const doc = await createDocument(prisma, world.a.shopId);
    const q = (await quoteFor(app, world.a.slug, doc.id)).json().data;
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { acceptsOrders: false } });
    const closed = await placeOrder(app, world.a.slug, q.quoteId);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('SHOP_UNAVAILABLE');
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { acceptsOrders: true, status: 'SUSPENDED' } });
    expect((await placeOrder(app, world.a.slug, q.quoteId)).statusCode).toBe(404);
    expect((await quoteFor(app, world.a.slug, doc.id)).statusCode).toBe(404);
    const lookup = await app.inject({ method: 'GET', url: `/api/v1/public/shops/${world.a.slug}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().data).toMatchObject({ status: 'SUSPENDED', acceptsOrders: false });
    expect(lookup.json().data).not.toHaveProperty('address');
    expect((await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/uploads/initiate`, payload: { fileName: 'a.pdf', byteSize: 10, declaredMimeType: 'application/pdf' } })).statusCode).toBe(404);
  });

  it('tracking returns a rich safe shape and constant 404s', async () => {
    const { trackingToken, doc } = await newOrder(app, prisma, world.a, { ...baseOptions, copies: 2 });
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/orders/${trackingToken}` });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d).toMatchObject({
      orderNumber: 'SHARMA-0001',
      shopName: 'Sharma Print',
      shopSlug: 'sharma-print',
      status: 'NEW',
      totalPaise: 4000,
      currency: 'INR',
      selectedPageCount: 10,
      printOptions: { colourMode: 'bw', copies: 2 },
      document: { fileName: 'notes.pdf', pageCount: 10, status: 'AVAILABLE' }
    });
    expect(d.timeline).toHaveLength(1);
    expect(new Date(d.serverTime).getTime()).toBeGreaterThan(0);
    const text = res.body;
    expect(text).not.toContain(doc.objectKey);
    expect(text).not.toContain(world.a.shopId);
    expect(text).not.toContain(doc.id);
    const unknown = await app.inject({ method: 'GET', url: `/api/v1/public/orders/${'z'.repeat(43)}` });
    const short = await app.inject({ method: 'GET', url: '/api/v1/public/orders/abc' });
    expect(unknown.statusCode).toBe(404);
    expect(short.statusCode).toBe(404);
    expect(short.json().error.code).toBe(unknown.json().error.code);
  });

  it('shop queue exposes card fields, newest first, with cursor pagination and filters', async () => {
    const s = await login(app, world.a.ownerEmail);
    const created = [];
    for (let i = 0; i < 5; i++) created.push((await newOrder(app, prisma, world.a, { ...baseOptions, colourMode: 'colour', sides: 'duplex', copies: 3 })).order);
    await newOrder(app, prisma, world.b);
    const page1 = (await call(app, s, 'GET', '/shop/orders?limit=2')).json().data;
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].orderNumber).toBe('SHARMA-0005');
    expect(page1.items[0]).toMatchObject({
      status: 'NEW', originalFilename: 'notes.pdf', pageCount: 10, selectedPageCount: 10, colourMode: 'colour', sides: 'duplex', copies: 3, documentStatus: 'AVAILABLE'
    });
    expect(page1.items[0]).toHaveProperty('customerDisplayNameOrReference');
    expect(page1.items[0]).toHaveProperty('deleteAfter');
    const page2 = (await call(app, s, 'GET', `/shop/orders?limit=2&cursor=${page1.nextCursor}`)).json().data;
    const page3 = (await call(app, s, 'GET', `/shop/orders?limit=2&cursor=${page2.nextCursor}`)).json().data;
    const all = [...page1.items, ...page2.items, ...page3.items].map((i: { orderNumber: string }) => i.orderNumber);
    expect(all).toEqual(['SHARMA-0005', 'SHARMA-0004', 'SHARMA-0003', 'SHARMA-0002', 'SHARMA-0001']);
    expect(page3.nextCursor).toBeUndefined();

    await prisma.order.update({ where: { id: created[0]!.id }, data: { status: 'CANCELLED' } });
    expect((await call(app, s, 'GET', '/shop/orders?status=CANCELLED')).json().data.items).toHaveLength(1);
    expect((await call(app, s, 'GET', '/shop/orders?status=NEW,ACCEPTED')).json().data.items).toHaveLength(4);
    expect((await call(app, s, 'GET', '/shop/orders?active=1')).json().data.items).toHaveLength(4);
    expect((await call(app, s, 'GET', '/shop/orders?status=BOGUS')).statusCode).toBe(400);
    expect((await call(app, s, 'GET', '/shop/orders?cursor=%%%')).statusCode).toBe(400);
  });
});
