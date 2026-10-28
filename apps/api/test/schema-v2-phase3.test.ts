import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baseOptions, createDocument, login, placeOrder, quoteFor } from './api-helpers.js';
import { makePdf } from './fixtures/make.js';
import { bearerAuth, cookieAuth, DEVICE_A, gtok, headersFor, req, startHarness, type Auth, type Harness } from './helpers/profile-harness.js';

/** Schema-v2 phase 3: customer uploads, quotes, orders, history and cancellation. Disposable DB only; no real customer files. */
describe('schema-v2 phase 3: customer orders', () => {
  let h: Harness;
  let age = 280;
  let alice: Auth;
  let bob: Auth;
  let aliceId: string;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: 'true' });
  });
  afterAll(async () => h.close());

  const data = (r: LightMyRequestResponse) => r.json().data as Record<string, any>;
  const asAuth = async (email: string) => {
    const s = await login(h.app, email);
    return cookieAuth(s.cookie, s.csrf);
  };
  async function newCustomer(name: string): Promise<{ auth: Auth; id: string }> {
    const restricted = await h.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'google', firebaseIdToken: gtok(`${name}${age}@cust.test`, { ago: age-- }), installationId: DEVICE_A, platform: 'android', audience: 'customer' } });
    const created = await req(h.app, bearerAuth(data(restricted).accessToken), 'POST', '/customers/onboarding', { name, client: 'mobile', deviceId: DEVICE_A });
    expect(created.statusCode, created.body).toBe(201);
    return { auth: bearerAuth(data(created).accessToken), id: data(created).user.id };
  }

  const shopA = () => h.world.a.shopId;
  const OPTIONS = { ...baseOptions, copies: 2 };

  /** presign -> PUT -> complete with a real generated PDF; returns the AVAILABLE document id. */
  async function uploadPdf(auth: Auth, shopId: string, pages = 3): Promise<string> {
    const pdf = await makePdf(pages);
    const init = await req(h.app, auth, 'POST', '/customer/uploads', { shopId, fileName: 'notes.pdf', byteSize: pdf.length, declaredMimeType: 'application/pdf' });
    expect(init.statusCode, init.body).toBe(200);
    const d = data(init);
    expect(JSON.stringify(d)).not.toContain('objectKey');
    const put = await h.app.inject({ method: 'PUT', url: d.uploadUrl, payload: pdf, headers: { 'content-type': 'application/pdf' } });
    expect(put.statusCode, put.body).toBe(200);
    const done = await h.app.inject({ method: 'POST', url: `/api/v1${d.completePath}` });
    expect(done.statusCode, done.body).toBe(200);
    expect(data(done)).toMatchObject({ pageCount: pages, documentStatus: 'AVAILABLE' });
    return d.uploadId as string;
  }
  const quote = (auth: Auth, shopId: string, documentId: string, printOptions: unknown = OPTIONS) => req(h.app, auth, 'POST', '/customer/quotes', { shopId, documentId, printOptions });
  const order = (auth: Auth, quoteId: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'POST', url: '/api/v1/customer/orders', headers: { ...headersFor(auth), ...headers }, payload: { quoteId, paymentMethod: 'cash', ...extra } });

  async function placed(auth: Auth, opts: { pages?: number; note?: string } = {}) {
    const docId = await uploadPdf(auth, shopA(), opts.pages);
    const q = await quote(auth, shopA(), docId);
    expect(q.statusCode, q.body).toBe(200);
    const o = await order(auth, data(q).quoteId, { clientRequestId: randomUUID(), ...(opts.note ? { note: opts.note } : {}) });
    expect(o.statusCode, o.body).toBe(201);
    return { docId, quote: data(q), order: data(o) };
  }

  beforeEach(async () => {
    await h.reseed();
    age = 280;
    for (const id of [h.world.a.shopId, h.world.b.shopId]) await h.prisma.shop.update({ where: { id }, data: { isVerified: true, verifiedAt: new Date(), status: 'ACTIVE', acceptsOrders: true } });
    const a = await newCustomer('alice');
    alice = a.auth;
    aliceId = a.id;
    bob = (await newCustomer('bob')).auth;
  });

  it('runs the full flow: upload, quote, order; the server owns the price and the order is bound to the customer', async () => {
    const { docId, quote: q, order: o } = await placed(alice, { pages: 3, note: 'Staple the pages' });
    // bw single-sided: 3 pages x 2 copies = 6 sheets x 200 paise
    expect(q).toMatchObject({ totalPaise: 1200 });
    expect(o).toMatchObject({ status: 'NEW', totalPaise: 1200, currency: 'INR', note: 'Staple the pages', shopId: shopA(), pages: 3 });
    expect(o.printOptions).toMatchObject({ colourMode: 'bw', sides: 'single', copies: 2 });
    for (const secret of ['trackingToken', 'objectKey', 'clientRequestId', 'uploaderUserId', 'customerUserId']) expect(JSON.stringify(o)).not.toContain(secret);
    const row = await h.prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { histories: true, document: true } });
    expect(row.customerUserId).toBe(aliceId);
    expect(row.document.uploaderUserId).toBe(aliceId);
    expect(row.histories).toMatchObject([{ toStatus: 'NEW', actorUserId: aliceId }]);
    expect(docId).toBe(row.documentId);
    // the shop sees it in its normal queue
    const owner = await asAuth(h.world.a.ownerEmail);
    const list = await req(h.app, owner, 'GET', '/shop/orders');
    expect(JSON.stringify(data(list))).toContain(o.orderNumber);
  });

  it('prices duplex exactly like the guest flow (same engine, per-sheet)', async () => {
    const docId = await uploadPdf(alice, shopA(), 5);
    const duplex = { ...baseOptions, sides: 'duplex', copies: 3 };
    const cq = await quote(alice, shopA(), docId, duplex);
    const guestDoc = await createDocument(h.prisma, shopA(), { pageCount: 5 });
    const gq = await quoteFor(h.app, h.world.a.slug, guestDoc.id, duplex);
    expect(gq.statusCode, gq.body).toBe(200);
    expect(data(cq).totalPaise).toBe(gq.json().data.totalPaise);
    expect(data(cq).totalPaise).toBe(3 * 180 * Math.ceil(5 / 2)); // 3 copies x 3 sheets x Rs 1.80
    expect(data(cq).printOptions).toEqual(gq.json().data.printOptions);
  });

  it('ignores nothing silently: client-supplied prices, unknown keys, bad copies, paper sizes and types are rejected', async () => {
    const docId = await uploadPdf(alice, shopA());
    for (const bad of [{ ...OPTIONS, totalPaise: 1 }, { ...OPTIONS, copies: 51 }, { ...OPTIONS, copies: 0 }, { ...OPTIONS, paperSize: 'A3' }, { ...OPTIONS, paperType: 'glossy' }, { ...OPTIONS, pricePerSheetPaise: 1 }]) {
      expect((await quote(alice, shopA(), docId, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await req(h.app, alice, 'POST', '/customer/quotes', { shopId: shopA(), documentId: docId, printOptions: OPTIONS, totalPaise: 1 })).statusCode).toBe(400);
    const q = await quote(alice, shopA(), docId, { ...OPTIONS, paperType: 'normal' });
    expect(q.statusCode).toBe(200);
    const id = randomUUID();
    for (const bad of [{ clientRequestId: id, totalPaise: 1 }, { clientRequestId: id, note: 'x'.repeat(501) }, { clientRequestId: 'not-a-uuid' }, {}]) {
      expect((await order(alice, data(q).quoteId, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await h.prisma.order.count({ where: { customerUserId: aliceId } })).toBe(0);
  });

  it('is idempotent per customer: replay returns the same order, a header works, and another customer gets 409 without a leak', async () => {
    const docId = await uploadPdf(alice, shopA());
    const q = await quote(alice, shopA(), docId);
    const key = randomUUID();
    const first = await order(alice, data(q).quoteId, { clientRequestId: key });
    const again = await order(alice, data(q).quoteId, {}, { 'idempotency-key': key });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode, again.body).toBe(201);
    expect(data(again).id).toBe(data(first).id);
    expect(await h.prisma.order.count({ where: { customerUserId: aliceId } })).toBe(1);
    expect((await order(alice, data(q).quoteId, { clientRequestId: key }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    // Bob reuses Alice's key with his own quote
    const bobDoc = await uploadPdf(bob, shopA());
    const bq = await quote(bob, shopA(), bobDoc);
    const leak = await order(bob, data(bq).quoteId, { clientRequestId: key });
    expect(leak.statusCode).toBe(409);
    expect(leak.body).not.toContain(data(first).orderNumber);
  });

  it('binds documents to their uploader: other customers and guests cannot quote or order them', async () => {
    const docId = await uploadPdf(alice, shopA());
    expect((await quote(bob, shopA(), docId)).statusCode).toBe(422);
    expect((await quoteFor(h.app, h.world.a.slug, docId)).statusCode).toBe(422);
    const aq = await quote(alice, shopA(), docId);
    // Bob presents Alice's valid quote token
    const stolen = await order(bob, data(aq).quoteId, { clientRequestId: randomUUID() });
    expect(stolen.statusCode).toBe(422);
    // A guest presents it through the public route
    const guest = await placeOrder(h.app, h.world.a.slug, data(aq).quoteId);
    expect(guest.statusCode).toBe(422);
    expect(await h.prisma.order.count()).toBe(0);
    // Alice's own guest-style doc cannot be used by a customer
    const guestDoc = await createDocument(h.prisma, shopA(), {});
    expect((await quote(alice, shopA(), guestDoc.id)).statusCode).toBe(422);
  });

  it('isolates order history, detail and cancel per customer (404, nothing changed)', async () => {
    const a = await placed(alice);
    const b = await placed(bob);
    const list = data(await req(h.app, alice, 'GET', '/customer/orders'));
    expect(list.items.map((o: any) => o.id)).toEqual([a.order.id]);
    expect(list).toMatchObject({ page: 1, limit: 20, total: 1 });
    expect((await req(h.app, bob, 'GET', `/customer/orders/${a.order.id}`)).statusCode).toBe(404);
    expect((await req(h.app, bob, 'POST', `/customer/orders/${a.order.id}/cancel`, {})).statusCode).toBe(404);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: a.order.id } })).status).toBe('NEW');
    const detail = data(await req(h.app, bob, 'GET', `/customer/orders/${b.order.id}`));
    expect(detail.statusHistory).toMatchObject([{ status: 'NEW', by: 'customer' }]);
    expect(JSON.stringify(detail)).not.toContain(aliceId);
    const filtered = data(await req(h.app, alice, 'GET', '/customer/orders?status=CANCELLED'));
    expect(filtered).toMatchObject({ items: [], total: 0 });
    expect((await req(h.app, alice, 'GET', '/customer/orders?limit=51')).statusCode).toBe(400);
  });

  it('cancels while NEW/ACCEPTED, is idempotent, and refuses once printing started', async () => {
    const a = await placed(alice);
    const c1 = await req(h.app, alice, 'POST', `/customer/orders/${a.order.id}/cancel`, { cancelReason: 'Wrong file' });
    expect(c1.statusCode, c1.body).toBe(200);
    expect(data(c1)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Wrong file' });
    expect((await req(h.app, alice, 'POST', `/customer/orders/${a.order.id}/cancel`, {})).statusCode).toBe(200);
    const history = await h.prisma.orderStatusHistory.findMany({ where: { orderId: a.order.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((x) => x.toStatus)).toEqual(['NEW', 'CANCELLED']);
    expect(history[1]).toMatchObject({ fromStatus: 'NEW', reason: 'Wrong file', actorUserId: aliceId });
    expect(await h.prisma.auditLog.count({ where: { action: 'order.cancelled_by_customer', actorType: 'CUSTOMER' } })).toBe(1);

    const b = await placed(alice);
    await h.prisma.order.update({ where: { id: b.order.id }, data: { status: 'ACCEPTED' } });
    expect((await req(h.app, alice, 'POST', `/customer/orders/${b.order.id}/cancel`, {})).statusCode).toBe(200);

    const c = await placed(alice);
    await h.prisma.order.update({ where: { id: c.order.id }, data: { status: 'PRINTING' } });
    const refused = await req(h.app, alice, 'POST', `/customer/orders/${c.order.id}/cancel`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('INVALID_STATUS_TRANSITION');

    const d = await placed(alice);
    await h.prisma.document.update({ where: { id: d.docId }, data: { printInitiatedAt: new Date() } });
    expect((await req(h.app, alice, 'POST', `/customer/orders/${d.order.id}/cancel`, {})).statusCode).toBe(409);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: d.order.id } })).status).toBe('NEW');
  });

  it('only orderable shops are usable: unverified, blocked, switched off and closed shops are refused', async () => {
    const pdf = await makePdf(1);
    const init = (shopId: string) => req(h.app, alice, 'POST', '/customer/uploads', { shopId, fileName: 'a.pdf', byteSize: pdf.length, declaredMimeType: 'application/pdf' });
    await h.prisma.shop.update({ where: { id: shopA() }, data: { isVerified: false } });
    expect((await init(shopA())).statusCode).toBe(404);
    await h.prisma.shop.update({ where: { id: shopA() }, data: { isVerified: true, acceptsOrders: false } });
    expect((await init(shopA())).statusCode).toBe(409);
    await h.prisma.shop.update({ where: { id: shopA() }, data: { acceptsOrders: true, status: 'SUSPENDED' } });
    expect((await init(shopA())).statusCode).toBe(404);
    await h.prisma.shop.update({ where: { id: shopA() }, data: { status: 'ACTIVE' } });
    await h.prisma.shopSettings.update({ where: { shopId: shopA() }, data: { afterHoursPolicy: 'BLOCK', temporaryClosure: { reason: 'Lunch', startedAt: new Date(Date.now() - 60_000).toISOString(), until: null } } });
    const closed = await init(shopA());
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('SHOP_CLOSED');
    expect((await req(h.app, alice, 'POST', '/customer/uploads', { shopId: 'nonexistent-shop', fileName: 'a.pdf', byteSize: 10, declaredMimeType: 'application/pdf' })).statusCode).toBe(404);
  });

  it('enforces the size cap, empty files, accepted types and the hourly presign limit', async () => {
    const base = { shopId: shopA(), fileName: 'a.pdf', declaredMimeType: 'application/pdf' };
    expect((await req(h.app, alice, 'POST', '/customer/uploads', { ...base, byteSize: 0 })).statusCode).toBe(422);
    const big = await req(h.app, alice, 'POST', '/customer/uploads', { ...base, byteSize: 52_428_801 });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.details).toEqual({ maxBytes: 52_428_800 });
    expect((await req(h.app, alice, 'POST', '/customer/uploads', { ...base, byteSize: 10, declaredMimeType: 'application/zip' })).statusCode).toBe(400);
    expect((await req(h.app, alice, 'POST', '/customer/uploads', { ...base, byteSize: 10, uploaderUserId: 'x' })).statusCode).toBe(400);
    for (let i = 0; i < 50; i++) await createDocument(h.prisma, shopA(), {}).then((d) => h.prisma.document.update({ where: { id: d.id }, data: { uploaderUserId: aliceId } }));
    const limited = await req(h.app, alice, 'POST', '/customer/uploads', { ...base, byteSize: 10 });
    expect(limited.statusCode).toBe(429);
    expect((await req(h.app, bob, 'POST', '/customer/uploads', { ...base, byteSize: 10 })).statusCode).toBe(200);
  });

  it('refuses owners, admins and anonymous callers on every customer order route', async () => {
    const owner = await asAuth(h.world.a.ownerEmail);
    const admin = await asAuth(h.world.adminEmail);
    for (const [method, url, body] of [['POST', '/customer/uploads', { shopId: shopA(), fileName: 'a.pdf', byteSize: 1, declaredMimeType: 'application/pdf' }], ['POST', '/customer/quotes', {}], ['POST', '/customer/orders', {}], ['GET', '/customer/orders', undefined], ['GET', '/customer/orders/abcdefghij', undefined], ['POST', '/customer/orders/abcdefghij/cancel', {}]] as const) {
      expect((await req(h.app, owner, method, url, body)).statusCode, `${method} ${url} owner`).toBe(403);
      expect((await req(h.app, admin, method, url, body)).statusCode, `${method} ${url} admin`).toBe(403);
      expect((await h.app.inject({ method, url: `/api/v1${url}`, ...(body ? { payload: body } : {}) })).statusCode, `${method} ${url} anon`).toBe(401);
    }
  });
});
