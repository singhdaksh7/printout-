import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { login, seedLegacyStatus } from './api-helpers.js';
import { makePdf } from './fixtures/make.js';
import { bearerAuth, cookieAuth, DEVICE_A, gtok, req, startHarness, type Auth, type Harness } from './helpers/profile-harness.js';

/**
 * Executable PDF contract test for the CUSTOMER endpoints (printout_buddy_schema.pdf pages 7-14).
 * Bodies are BARE JSON (no `{ data }` envelope); errors are `{ code, message, details? }`.
 * Approved differences from the PDF that this suite pins (see src/contract/customer.ts header):
 *  - 50 MiB upload ceiling (not 20 MB) and the short document retention window (not 7 days).
 *  - Server-authoritative per-sheet pricing: single-sided pricePerPagePaise == the per-sheet rate; totalPaise is the server quote.
 *  - Bearer = app-issued access token; referralCode is null; presign needs an extra shopId.
 * Disposable DB only.
 */
describe('PDF contract: customer endpoints', () => {
  let h: Harness;
  let age = 280;
  let alice: Auth;
  let bob: Auth;
  let aliceId: string;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: 'true' });
  });
  afterAll(async () => h.close());

  const body = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  const PDF_HEADER = { 'x-api-contract': 'pdf' };
  const asAuth = async (email: string) => {
    const s = await login(h.app, email);
    return cookieAuth(s.cookie, s.csrf);
  };
  async function newCustomer(name: string): Promise<{ auth: Auth; id: string }> {
    const restricted = await h.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'google', firebaseIdToken: gtok(`${name}${age}@cust.test`, { ago: age-- }), installationId: DEVICE_A, platform: 'android', audience: 'customer' } });
    const created = await req(h.app, bearerAuth(restricted.json().data.accessToken), 'POST', '/customers/onboarding', { name, client: 'mobile', deviceId: DEVICE_A });
    expect(created.statusCode, created.body).toBe(201);
    return { auth: bearerAuth(created.json().data.accessToken), id: created.json().data.user.id };
  }
  const shopA = () => h.world.a.shopId;
  const expectError = (res: LightMyRequestResponse, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    expect(body(res)).toMatchObject({ code });
    expect(typeof body(res).message).toBe('string');
    expect(body(res).error).toBeUndefined(); // never the app envelope
  };

  /** presign -> PUT -> (no separate complete step in the PDF flow) -> returns the fileKey. */
  async function upload(auth: Auth, shopId: string, pages = 3, fileName = 'notes.pdf'): Promise<string> {
    const pdf = await makePdf(pages);
    const pre = await req(h.app, auth, 'POST', '/uploads/presign', { shopId, fileName, contentType: 'application/pdf', sizeBytes: pdf.length });
    expect(pre.statusCode, pre.body).toBe(200);
    const d = body(pre);
    expect(Object.keys(d)).toEqual(expect.arrayContaining(['uploadUrl', 'fileKey', 'expiresAt']));
    const put = await h.app.inject({ method: 'PUT', url: d.uploadUrl, payload: pdf, headers: { 'content-type': 'application/pdf' } });
    expect(put.statusCode, put.body).toBe(200);
    return d.fileKey as string;
  }
  const ORDER = { printingType: 'blackWhite', paperSize: 'A4', paperType: 'normal', copies: 2, paymentMethod: 'cash' } as const;
  const placeOrder = (auth: Auth, fileKey: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    req(h.app, auth, 'POST', '/orders', { shopId: shopA(), fileKey, fileName: 'notes.pdf', fileContentType: 'application/pdf', fileSizeBytes: 1000, pages: 1, ...ORDER, ...extra }, headers);
  async function placed(auth: Auth, opts: { pages?: number; extra?: Record<string, unknown> } = {}) {
    const key = await upload(auth, shopA(), opts.pages ?? 3);
    const res = await placeOrder(auth, key, opts.extra);
    expect(res.statusCode, res.body).toBe(201);
    return body(res);
  }
  const enableUpi = () => h.prisma.shop.update({ where: { id: shopA() }, data: { upiId: 'ramesh@okbank', acceptedPaymentMethods: ['CASH', 'UPI'] } });

  beforeEach(async () => {
    await h.reseed();
    age = 280;
    for (const id of [h.world.a.shopId, h.world.b.shopId]) {
      await h.prisma.shop.update({ where: { id }, data: { isVerified: true, verifiedAt: new Date(), status: 'ACTIVE', acceptsOrders: true, city: 'Ghaziabad', pincode: '201001', latitude: 28.6692, longitude: 77.4538 } });
    }
    const a = await newCustomer('alice');
    alice = a.auth;
    aliceId = a.id;
    bob = (await newCustomer('bob')).auth;
  });

  describe('GET/PATCH /me', () => {
    it('GET /me returns exactly the PDF fields; only stored values are filled, the rest are null', async () => {
      const res = await req(h.app, alice, 'GET', '/me');
      expect(res.statusCode, res.body).toBe(200);
      const me = body(res);
      expect(Object.keys(me).sort()).toEqual(
        ['id', 'roles', 'name', 'email', 'phoneNumber', 'emailVerified', 'phoneVerified', 'loginMethods', 'referralCode', 'addressLine1', 'addressLine2', 'city', 'state', 'country', 'pincode', 'latitude', 'longitude'].sort()
      );
      expect(me).toMatchObject({ id: aliceId, roles: ['customer'], name: 'alice', referralCode: null, addressLine1: null, pincode: null, latitude: null });
      expect(JSON.stringify(me)).not.toMatch(/firebaseUid|passwordHash|fcm/i);
      expect(me.data).toBeUndefined(); // bare, not enveloped
    });

    it('requires a signed-in account', async () => {
      expectError(await h.app.inject({ method: 'GET', url: '/api/v1/me' }), 401, 'INVALID_TOKEN');
    });

    it('PATCH /me updates only the sent fields and answers {id,name,email,pincode}', async () => {
      const res = await req(h.app, alice, 'PATCH', '/me', { name: 'Rahul Kumar', pincode: '201001', city: 'Ghaziabad', latitude: 28.6692, longitude: 77.4538 });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toEqual({ id: aliceId, name: 'Rahul Kumar', email: expect.anything(), pincode: '201001' });
      const me = body(await req(h.app, alice, 'GET', '/me'));
      expect(me).toMatchObject({ name: 'Rahul Kumar', city: 'Ghaziabad', pincode: '201001', latitude: 28.6692, longitude: 77.4538, addressLine1: null });
    });

    it('PATCH /me rejects a bad pincode (VALIDATION_ERROR) and a lone latitude; an empty body is invalid', async () => {
      const bad = await req(h.app, alice, 'PATCH', '/me', { pincode: '12' });
      expectError(bad, 400, 'VALIDATION_ERROR');
      expect(body(bad).details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'pincode' })]));
      expectError(await req(h.app, alice, 'PATCH', '/me', { latitude: 12.5 }), 400, 'VALIDATION_ERROR');
      expectError(await req(h.app, alice, 'PATCH', '/me', {}), 400, 'VALIDATION_ERROR');
    });

    it('PATCH /me email: unique across accounts (409 EMAIL_TAKEN) and stored lower-case', async () => {
      expect((await req(h.app, alice, 'PATCH', '/me', { email: 'Rahul@Example.com' })).statusCode).toBe(200);
      expect(body(await req(h.app, alice, 'GET', '/me')).email).toBe('rahul@example.com');
      expectError(await req(h.app, bob, 'PATCH', '/me', { email: 'rahul@example.com' }), 409, 'EMAIL_TAKEN');
    });
  });

  describe('PUT/DELETE /me/fcm-token', () => {
    const TOKEN = 'fcm-token-for-alice-0000000000000001';
    it('stores encrypted (never returned), replays idempotently, and DELETE removes it', async () => {
      const put = await req(h.app, alice, 'PUT', '/me/fcm-token', { token: TOKEN, platform: 'android' });
      expect(put.statusCode, put.body).toBe(204);
      expect(put.body).toBe('');
      expect((await req(h.app, alice, 'PUT', '/me/fcm-token', { token: TOKEN, platform: 'android' })).statusCode).toBe(204);
      const rows = await h.prisma.fcmRegistration.findMany({ where: { userId: aliceId, revokedAt: null } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(TOKEN); // encrypted at rest
      const del = await req(h.app, alice, 'DELETE', `/me/fcm-token?token=${TOKEN}`);
      expect(del.statusCode, del.body).toBe(204);
      expect(await h.prisma.fcmRegistration.count({ where: { userId: aliceId, revokedAt: null } })).toBe(0);
    });

    it('validates input and does not let one user remove another user\'s token', async () => {
      expectError(await req(h.app, alice, 'PUT', '/me/fcm-token', { token: TOKEN, platform: 'windows' }), 400, 'VALIDATION_ERROR');
      expectError(await req(h.app, alice, 'DELETE', '/me/fcm-token'), 400, 'VALIDATION_ERROR');
      await req(h.app, alice, 'PUT', '/me/fcm-token', { token: TOKEN, platform: 'ios' });
      expect((await req(h.app, bob, 'DELETE', `/me/fcm-token?token=${TOKEN}`)).statusCode).toBe(204);
      expect(await h.prisma.fcmRegistration.count({ where: { userId: aliceId, revokedAt: null } })).toBe(1);
    });
  });

  describe('shops', () => {
    it('GET /shops/nearby returns the PDF item shape sorted by distance, with single-sided per-page rates', async () => {
      await h.prisma.shop.update({ where: { id: h.world.b.shopId }, data: { latitude: 28.7, longitude: 77.5 } });
      const res = await req(h.app, alice, 'GET', '/shops/nearby?lat=28.6692&lng=77.4538&radiusKm=20');
      expect(res.statusCode, res.body).toBe(200);
      const b = body(res);
      expect(b).toMatchObject({ page: 1, limit: 20, total: 2 });
      expect(b.items.map((s: any) => s.id)).toEqual([h.world.a.shopId, h.world.b.shopId]);
      const first = b.items[0];
      expect(Object.keys(first).sort()).toEqual(['city', 'distanceKm', 'id', 'isOpen', 'ratingAvg', 'ratingCount', 'rates', 'shopName'].sort());
      expect(first).toMatchObject({ shopName: 'Sharma Print', city: 'Ghaziabad', isOpen: true, ratingCount: 0 });
      expect(first.rates).toEqual(expect.arrayContaining([{ printingType: 'blackWhite', pricePerPagePaise: 200 }, { printingType: 'colored', pricePerPagePaise: 1000 }]));
      expect(first.rates).toHaveLength(2); // duplex rules are not exposed as per-page rates
      expect(first.distanceKm).toBeLessThan(b.items[1].distanceKm);
    });

    it('nearby: lat/lng required (VALIDATION_ERROR), printingType filter, unverified/blocked shops hidden, paging', async () => {
      expectError(await req(h.app, alice, 'GET', '/shops/nearby?lat=28.6'), 400, 'VALIDATION_ERROR');
      await h.prisma.pricingRule.deleteMany({ where: { shopId: h.world.b.shopId, colourMode: 'colour' } });
      const colored = body(await req(h.app, alice, 'GET', '/shops/nearby?lat=28.6692&lng=77.4538&printingType=colored'));
      expect(colored.items.map((s: any) => s.id)).toEqual([h.world.a.shopId]);
      await h.prisma.shop.update({ where: { id: h.world.b.shopId }, data: { isVerified: false } });
      await h.prisma.shop.update({ where: { id: shopA() }, data: { status: 'SUSPENDED' } });
      expect(body(await req(h.app, alice, 'GET', '/shops/nearby?lat=28.6692&lng=77.4538&radiusKm=20')).total).toBe(0);
      await h.prisma.shop.update({ where: { id: shopA() }, data: { status: 'ACTIVE' } });
      const paged = body(await req(h.app, alice, 'GET', '/shops/nearby?lat=28.6692&lng=77.4538&page=2&limit=1'));
      expect(paged).toMatchObject({ page: 2, limit: 1, total: 1, items: [] });
    });

    it('GET /shops/{id} with X-API-Contract: pdf returns the PDF detail; without the header the owner route is untouched', async () => {
      await enableUpi();
      const res = await req(h.app, alice, 'GET', `/shops/${shopA()}`, undefined, PDF_HEADER);
      expect(res.statusCode, res.body).toBe(200);
      const s = body(res);
      expect(s).toMatchObject({
        id: shopA(),
        shopName: 'Sharma Print',
        city: 'Ghaziabad',
        pincode: '201001',
        location: { latitude: 28.6692, longitude: 77.4538 },
        isOpen: true,
        upiId: 'ramesh@okbank',
        acceptedPaymentMethods: ['cash', 'upi'],
        showQr: false,
        qrCodeUrl: null
      });
      expect(s.rates).toHaveLength(2);
      expect(Array.isArray(s.paperSizes)).toBe(true);
      expect(Array.isArray(s.paperTypes)).toBe(true);
      expect(Array.isArray(s.images)).toBe(true);
      // the shop owner's own (app-native) route still answers in its envelope for requests without the header
      const owner = await asAuth(h.world.a.ownerEmail);
      const native = await req(h.app, owner, 'GET', `/shops/${shopA()}`);
      expect(native.statusCode, native.body).toBe(200);
      expect(body(native).data).toBeDefined();
    });

    it('GET /shops/{id}: unverified, blocked and unknown shops are 404 SHOP_NOT_FOUND', async () => {
      await h.prisma.shop.update({ where: { id: shopA() }, data: { isVerified: false } });
      expectError(await req(h.app, alice, 'GET', `/shops/${shopA()}`, undefined, PDF_HEADER), 404, 'SHOP_NOT_FOUND');
      await h.prisma.shop.update({ where: { id: shopA() }, data: { isVerified: true, status: 'SUSPENDED' } });
      expectError(await req(h.app, alice, 'GET', `/shops/${shopA()}`, undefined, PDF_HEADER), 404, 'SHOP_NOT_FOUND');
      expectError(await req(h.app, alice, 'GET', '/shops/does-not-exist-123', undefined, PDF_HEADER), 404, 'SHOP_NOT_FOUND');
    });

    it('GET /shops/{id}/reviews is paginated newest first with a masked customer name', async () => {
      const o1 = await placed(alice);
      await seedLegacyStatus(h.prisma, o1.id, 'COLLECTED');
      expect((await req(h.app, alice, 'POST', '/reviews', { orderId: o1.id, rating: 5, comment: 'Fast and clean print' })).statusCode).toBe(201);
      const res = await req(h.app, bob, 'GET', `/shops/${shopA()}/reviews`, undefined, PDF_HEADER);
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toMatchObject({ page: 1, limit: 20, total: 1 });
      expect(body(res).items[0]).toMatchObject({ rating: 5, comment: 'Fast and clean print', customerName: 'alice' });
      expect(Object.keys(body(res).items[0]).sort()).toEqual(['comment', 'createdAt', 'customerName', 'id', 'rating']);
      expectError(await req(h.app, bob, 'GET', '/shops/does-not-exist-123/reviews', undefined, PDF_HEADER), 404, 'SHOP_NOT_FOUND');
    });
  });

  describe('POST /uploads/presign', () => {
    const base = { shopId: undefined as string | undefined, fileName: 'notes.pdf', contentType: 'application/pdf', sizeBytes: 1000 };
    it('returns uploadUrl, fileKey (uploads/{userId}/...) and expiresAt', async () => {
      const res = await req(h.app, alice, 'POST', '/uploads/presign', { ...base, shopId: shopA() });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res).fileKey).toMatch(new RegExp(`^uploads/${aliceId}/[A-Za-z0-9_-]{24}-notes\\.pdf$`));
      expect(typeof body(res).uploadUrl).toBe('string');
      expect(new Date(body(res).expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
    it('UNSUPPORTED_FILE_TYPE (400), FILE_TOO_LARGE (400, approved 50 MiB ceiling), VALIDATION_ERROR without a shopId', async () => {
      expectError(await req(h.app, alice, 'POST', '/uploads/presign', { ...base, shopId: shopA(), contentType: 'application/zip' }), 400, 'UNSUPPORTED_FILE_TYPE');
      const tooBig = await req(h.app, alice, 'POST', '/uploads/presign', { ...base, shopId: shopA(), sizeBytes: 60 * 1024 * 1024 });
      expectError(tooBig, 400, 'FILE_TOO_LARGE');
      // 20 MB..50 MiB is ACCEPTED here: the owner kept the 50 MiB ceiling (documented difference).
      expect((await req(h.app, alice, 'POST', '/uploads/presign', { ...base, shopId: shopA(), sizeBytes: 30 * 1024 * 1024 })).statusCode).toBe(200);
      expectError(await req(h.app, alice, 'POST', '/uploads/presign', base), 400, 'VALIDATION_ERROR');
    });
    it('is for customers only and needs a token', async () => {
      expectError(await h.app.inject({ method: 'POST', url: '/api/v1/uploads/presign', payload: { ...base, shopId: shopA() } }), 401, 'INVALID_TOKEN');
      const owner = await asAuth(h.world.a.ownerEmail);
      expect((await req(h.app, owner, 'POST', '/uploads/presign', { ...base, shopId: shopA() })).statusCode).toBe(403);
    });
  });

  describe('POST /orders', () => {
    it('creates the order (201) with server-calculated price; client amounts are ignored', async () => {
      const key = await upload(alice, shopA(), 3);
      const res = await placeOrder(alice, key, { totalPaise: 1, pricePerPagePaise: 1, pages: 99, note: 'Print double sided' });
      expect(res.statusCode, res.body).toBe(201);
      const o = body(res);
      // bw single-sided Rs 2.00/page: 3 pages (server count, not the client's 99) x 2 copies
      expect(o).toMatchObject({
        shopId: shopA(),
        shopName: 'Sharma Print',
        status: 'pending',
        paymentMethod: 'cash',
        paymentStatus: 'unpaid',
        printingType: 'blackWhite',
        paperSize: 'A4',
        paperType: 'normal',
        pages: 3,
        copies: 2,
        totalPages: 6,
        pricePerPagePaise: 200,
        totalPaise: 1200,
        note: 'Print double sided'
      });
      expect(o.totalPaise).toBe(o.pricePerPagePaise * o.totalPages);
      expect(o.orderNumber).toMatch(/-\d{4}$/);
      expect(typeof o.createdAt).toBe('string');
      const row = await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      expect(row).toMatchObject({ customerUserId: aliceId, totalPaise: 1200, status: 'NEW' });
      expect(JSON.stringify(o)).not.toMatch(/trackingToken|objectKey|clientRequestId|customerUserId/);
    });

    it('colored uses the colour single-sided rate', async () => {
      const o = await placed(alice, { pages: 2, extra: { printingType: 'colored', copies: 1 } });
      expect(o).toMatchObject({ printingType: 'colored', pricePerPagePaise: 1000, totalPaise: 2000, totalPages: 2 });
    });

    it('honours Idempotency-Key: a retry returns the same order and creates no duplicate; keys are per customer', async () => {
      const key = await upload(alice, shopA());
      const headers = { 'idempotency-key': 'order-attempt-1' };
      const first = await placeOrder(alice, key, {}, headers);
      const again = await placeOrder(alice, key, {}, headers);
      expect(first.statusCode, first.body).toBe(201);
      expect(again.statusCode, again.body).toBe(201);
      expect(body(again).id).toBe(body(first).id);
      expect(await h.prisma.order.count({ where: { customerUserId: aliceId } })).toBe(1);
      // the same key from another customer is a different request
      const bobKey = await upload(bob, shopA());
      const bobs = await placeOrder(bob, bobKey, {}, headers);
      expect(bobs.statusCode, bobs.body).toBe(201);
      expect(body(bobs).id).not.toBe(body(first).id);
    });

    it('SHOP_NOT_FOUND (404) for unknown/unverified shops, SHOP_CLOSED (422) when the shop is not taking orders', async () => {
      const key = await upload(alice, shopA());
      expectError(await placeOrder(alice, key, { shopId: 'does-not-exist-123' }), 404, 'SHOP_NOT_FOUND');
      await h.prisma.shop.update({ where: { id: shopA() }, data: { acceptsOrders: false } });
      expectError(await placeOrder(alice, key), 422, 'SHOP_CLOSED');
      expect(await h.prisma.order.count()).toBe(0);
    });

    it('RATE_NOT_SET (422) when the shop has no single-sided rate for the printing type', async () => {
      const key = await upload(alice, shopA());
      await h.prisma.pricingRule.deleteMany({ where: { shopId: shopA(), colourMode: 'colour' } });
      expectError(await placeOrder(alice, key, { printingType: 'colored' }), 422, 'RATE_NOT_SET');
    });

    it('UNSUPPORTED_PAPER (400) for paper the shop lacks or that cannot be priced; PAYMENT_METHOD_NOT_ACCEPTED (400) for UPI without UPI', async () => {
      const key = await upload(alice, shopA());
      expectError(await placeOrder(alice, key, { paperSize: 'A3' }), 400, 'UNSUPPORTED_PAPER');
      expectError(await placeOrder(alice, key, { paperType: 'glossy' }), 400, 'UNSUPPORTED_PAPER');
      // listed by the shop but unpriced today (approved: only A4/normal has a price)
      await h.prisma.shopPaperOption.createMany({ data: [{ shopId: shopA(), kind: 'paperSize', value: 'A3' }, { shopId: shopA(), kind: 'paperSize', value: 'A4' }] });
      expectError(await placeOrder(alice, key, { paperSize: 'A3' }), 400, 'UNSUPPORTED_PAPER');
      expectError(await placeOrder(alice, key, { paymentMethod: 'upi' }), 400, 'PAYMENT_METHOD_NOT_ACCEPTED');
      await enableUpi();
      expect((await placeOrder(alice, key, { paymentMethod: 'upi' })).statusCode).toBe(201);
    });

    it('FILE_NOT_FOUND (422) for an unknown key or an object never uploaded; another customer\'s key is 403', async () => {
      expectError(await placeOrder(alice, 'uploads/nobody/whatever.pdf'), 422, 'FILE_NOT_FOUND');
      const pre = await req(h.app, alice, 'POST', '/uploads/presign', { shopId: shopA(), fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1000 });
      expectError(await placeOrder(alice, body(pre).fileKey), 422, 'FILE_NOT_FOUND'); // presigned but never PUT
      const bobKey = await upload(bob, shopA());
      expectError(await placeOrder(alice, bobKey), 403, 'FORBIDDEN');
    });

    it('VALIDATION_ERROR (400) for copies out of range, and a second order on the same file is refused', async () => {
      const key = await upload(alice, shopA());
      expectError(await placeOrder(alice, key, { copies: 0 }), 400, 'VALIDATION_ERROR');
      expectError(await placeOrder(alice, key, { copies: 51 }), 400, 'VALIDATION_ERROR');
      expect((await placeOrder(alice, key)).statusCode).toBe(201);
      expect((await placeOrder(alice, key)).statusCode).toBe(409);
    });

    it('requires a customer session', async () => {
      expectError(await h.app.inject({ method: 'POST', url: '/api/v1/orders', payload: {} }), 401, 'INVALID_TOKEN');
      const owner = await asAuth(h.world.a.ownerEmail);
      expect((await req(h.app, owner, 'POST', '/orders', {})).statusCode).toBe(403);
    });
  });

  describe('GET /orders, GET /orders/{id}, GET /orders/{id}/file', () => {
    it('lists only my orders, newest first, with the PDF item shape, status filter and paging', async () => {
      const o1 = await placed(alice);
      const o2 = await placed(alice);
      await placed(bob);
      await seedLegacyStatus(h.prisma, o1.id, 'COLLECTED');
      const all = body(await req(h.app, alice, 'GET', '/orders'));
      expect(all).toMatchObject({ page: 1, limit: 20, total: 2 });
      expect(all.items.map((i: any) => i.id)).toEqual([o2.id, o1.id]);
      expect(Object.keys(all.items[0]).sort()).toEqual(['createdAt', 'id', 'orderNumber', 'paymentStatus', 'shopName', 'status', 'totalPaise']);
      expect(body(await req(h.app, alice, 'GET', '/orders?status=completed')).items.map((i: any) => i.id)).toEqual([o1.id]);
      expect(body(await req(h.app, alice, 'GET', '/orders?status=pending')).items.map((i: any) => i.id)).toEqual([o2.id]);
      expect(body(await req(h.app, alice, 'GET', '/orders?limit=1&page=2')).items).toHaveLength(1);
      expectError(await req(h.app, alice, 'GET', '/orders?status=NEW'), 400, 'VALIDATION_ERROR');
    });

    it('maps internal statuses to the PDF vocabulary', async () => {
      const o = await placed(alice);
      for (const [internal, pdf] of [['ACCEPTED', 'accepted'], ['PRINTING', 'printing'], ['PRINTED', 'printing'], ['READY', 'ready'], ['COLLECTED', 'completed']] as const) {
        await seedLegacyStatus(h.prisma, o.id, internal);
        expect(body(await req(h.app, alice, 'GET', `/orders/${o.id}`)).status, internal).toBe(pdf);
      }
      await h.prisma.order.update({ where: { id: o.id }, data: { status: 'REJECTED' } });
      expect(body(await req(h.app, alice, 'GET', `/orders/${o.id}`)).status).toBe('rejected');
      await h.prisma.order.update({ where: { id: o.id }, data: { status: 'EXPIRED' } });
      expect(body(await req(h.app, alice, 'GET', `/orders/${o.id}`)).status).toBe('cancelled');
    });

    it('order detail has the status history; another customer gets 403 NOT_ORDER_OWNER, an unknown id 404 ORDER_NOT_FOUND, the shop owner may read it', async () => {
      const o = await placed(alice);
      await seedLegacyStatus(h.prisma, o.id, 'ACCEPTED');
      const res = await req(h.app, alice, 'GET', `/orders/${o.id}`);
      expect(res.statusCode, res.body).toBe(200);
      const d = body(res);
      expect(d).toMatchObject({ id: o.id, orderNumber: o.orderNumber, status: 'accepted', paymentStatus: 'unpaid', fileName: 'notes.pdf', pages: 3, copies: 2, totalPages: 6, totalPaise: 1200 });
      expect(d.statusHistory.map((s: any) => s.status)).toEqual(['pending', 'accepted']);
      expect(d.statusHistory[0]).toMatchObject({ changedBy: aliceId });
      expect(typeof d.statusHistory[0].createdAt).toBe('string');
      expectError(await req(h.app, bob, 'GET', `/orders/${o.id}`), 403, 'NOT_ORDER_OWNER');
      expectError(await req(h.app, alice, 'GET', '/orders/does-not-exist-123'), 404, 'ORDER_NOT_FOUND');
      const owner = await asAuth(h.world.a.ownerEmail);
      expect((await req(h.app, owner, 'GET', `/orders/${o.id}`)).statusCode).toBe(200);
      const otherOwner = await asAuth(h.world.b.ownerEmail);
      expectError(await req(h.app, otherOwner, 'GET', `/orders/${o.id}`), 403, 'NOT_ORDER_OWNER');
    });

    it('GET /orders/{id}/file returns a short-lived signed URL for the customer and the shop owner only', async () => {
      const o = await placed(alice);
      const res = await req(h.app, alice, 'GET', `/orders/${o.id}/file`);
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toMatchObject({ fileName: 'notes.pdf' });
      expect(typeof body(res).downloadUrl).toBe('string');
      const ttl = new Date(body(res).expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(5 * 60_000 + 1000);
      const owner = await asAuth(h.world.a.ownerEmail);
      expect((await req(h.app, owner, 'GET', `/orders/${o.id}/file`)).statusCode).toBe(200);
      expectError(await req(h.app, bob, 'GET', `/orders/${o.id}/file`), 403, 'NOT_ORDER_OWNER');
    });

    it('GET /orders/{id}/file answers 410 FILE_DELETED once the file is gone (short retention is the approved policy)', async () => {
      const o = await placed(alice);
      await h.prisma.document.updateMany({ where: { order: { id: o.id } }, data: { status: 'DELETED', deletedAt: new Date() } });
      expectError(await req(h.app, alice, 'GET', `/orders/${o.id}/file`), 410, 'FILE_DELETED');
    });
  });

  describe('POST /orders/{id}/cancel', () => {
    it('cancels a pending order and returns {id,status,cancelReason}', async () => {
      const o = await placed(alice);
      const res = await req(h.app, alice, 'POST', `/orders/${o.id}/cancel`, { cancelReason: 'Uploaded the wrong file' });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toEqual({ id: o.id, status: 'cancelled', cancelReason: 'Uploaded the wrong file' });
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('CANCELLED');
    });
    it('is allowed while accepted, and 409 INVALID_TRANSITION once printing started', async () => {
      const a = await placed(alice);
      await seedLegacyStatus(h.prisma, a.id, 'ACCEPTED');
      expect((await req(h.app, alice, 'POST', `/orders/${a.id}/cancel`, {})).statusCode).toBe(200);
      const p = await placed(alice);
      await seedLegacyStatus(h.prisma, p.id, 'PRINTING');
      expectError(await req(h.app, alice, 'POST', `/orders/${p.id}/cancel`, {}), 409, 'INVALID_TRANSITION');
    });
    it('only the customer who placed it: 403 NOT_ORDER_OWNER / 404 ORDER_NOT_FOUND', async () => {
      const o = await placed(alice);
      expectError(await req(h.app, bob, 'POST', `/orders/${o.id}/cancel`, {}), 403, 'NOT_ORDER_OWNER');
      expectError(await req(h.app, alice, 'POST', '/orders/does-not-exist-123/cancel', {}), 404, 'ORDER_NOT_FOUND');
    });
  });

  describe('POST /orders/{id}/payment', () => {
    it('saves the UTR: paymentStatus becomes pendingVerification', async () => {
      await enableUpi();
      const o = await placed(alice, { extra: { paymentMethod: 'upi' } });
      expect(o).toMatchObject({ paymentMethod: 'upi', paymentStatus: 'unpaid' });
      const res = await req(h.app, alice, 'POST', `/orders/${o.id}/payment`, { upiTxnRef: '412345678901' });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toEqual({ id: o.id, paymentMethod: 'upi', paymentStatus: 'pendingVerification', upiTxnRef: '412345678901' });
    });
    it('409 NOT_UPI_ORDER for cash, 409 INVALID_TRANSITION on a second reference, 409 DUPLICATE_UTR across orders of one shop', async () => {
      const cash = await placed(alice);
      expectError(await req(h.app, alice, 'POST', `/orders/${cash.id}/payment`, { upiTxnRef: '412345678901' }), 409, 'NOT_UPI_ORDER');
      await enableUpi();
      const u1 = await placed(alice, { extra: { paymentMethod: 'upi' } });
      expect((await req(h.app, alice, 'POST', `/orders/${u1.id}/payment`, { upiTxnRef: '412345678901' })).statusCode).toBe(200);
      expectError(await req(h.app, alice, 'POST', `/orders/${u1.id}/payment`, { upiTxnRef: '412345678902' }), 409, 'INVALID_TRANSITION');
      const u2 = await placed(bob, { extra: { paymentMethod: 'upi' } });
      expectError(await req(h.app, bob, 'POST', `/orders/${u2.id}/payment`, { upiTxnRef: '412345678901' }), 409, 'DUPLICATE_UTR');
    });
    it('validates the reference and ownership', async () => {
      await enableUpi();
      const o = await placed(alice, { extra: { paymentMethod: 'upi' } });
      expectError(await req(h.app, alice, 'POST', `/orders/${o.id}/payment`, { upiTxnRef: 'x' }), 400, 'VALIDATION_ERROR');
      expectError(await req(h.app, alice, 'POST', `/orders/${o.id}/payment`, {}), 400, 'VALIDATION_ERROR');
      expectError(await req(h.app, bob, 'POST', `/orders/${o.id}/payment`, { upiTxnRef: '412345678901' }), 403, 'NOT_ORDER_OWNER');
    });
  });

  describe('POST /reviews', () => {
    it('saves the rating once printing is done and updates the shop average', async () => {
      const o = await placed(alice);
      await seedLegacyStatus(h.prisma, o.id, 'COLLECTED');
      const res = await req(h.app, alice, 'POST', '/reviews', { orderId: o.id, rating: 5, comment: 'Fast and clean print' });
      expect(res.statusCode, res.body).toBe(201);
      expect(body(res)).toMatchObject({ orderId: o.id, shopId: shopA(), rating: 5, comment: 'Fast and clean print' });
      expect(Object.keys(body(res)).sort()).toEqual(['comment', 'createdAt', 'id', 'orderId', 'rating', 'shopId']);
      expect(await h.prisma.shop.findUniqueOrThrow({ where: { id: shopA() }, select: { ratingAvg: true, ratingCount: true } })).toEqual({ ratingAvg: 5, ratingCount: 1 });
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).isReviewed).toBe(true);
    });
    it('409 REVIEW_EXISTS, 422 ORDER_NOT_COMPLETED, 403 NOT_ORDER_OWNER, 400 VALIDATION_ERROR', async () => {
      const o = await placed(alice);
      expectError(await req(h.app, alice, 'POST', '/reviews', { orderId: o.id, rating: 4 }), 422, 'ORDER_NOT_COMPLETED');
      await seedLegacyStatus(h.prisma, o.id, 'COLLECTED');
      expectError(await req(h.app, bob, 'POST', '/reviews', { orderId: o.id, rating: 4 }), 403, 'NOT_ORDER_OWNER');
      expectError(await req(h.app, alice, 'POST', '/reviews', { orderId: o.id, rating: 6 }), 400, 'VALIDATION_ERROR');
      expect((await req(h.app, alice, 'POST', '/reviews', { orderId: o.id, rating: 4 })).statusCode).toBe(201);
      expectError(await req(h.app, alice, 'POST', '/reviews', { orderId: o.id, rating: 4 }), 409, 'REVIEW_EXISTS');
    });
  });

  it('cookie sessions need CSRF on the PDF mutations too (no new bypass)', async () => {
    const owner = await login(h.app, h.world.a.ownerEmail);
    const noCsrf = await h.app.inject({ method: 'PATCH', url: '/api/v1/me', headers: { cookie: owner.cookie }, payload: { name: 'Mallory' } });
    expect(noCsrf.statusCode).toBe(403);
  });
});
