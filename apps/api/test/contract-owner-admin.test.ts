import { Readable } from 'node:stream';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDocument, login, newOrder, testConfig } from './api-helpers.js';
import { cookieAuth, headersFor, req, startHarness, type Auth, type Harness } from './helpers/profile-harness.js';
import { createStorage, generateObjectKey } from '../src/storage/index.js';

/**
 * Executable contract test for the PDF owner + admin endpoints (printout_buddy_schema.pdf pages 15-19), selected with
 * `X-API-Contract: pdf`. Approved differences are asserted as such: server-authoritative PER-SHEET pricing (the per-page PDF rate
 * maps to a single-sided sheet = P and a duplex sheet = 2P), shop-side status changes other than rejection are produced by the
 * Print action (409 INVALID_TRANSITION), customerPhone is never exposed, refunds stay admin-only, no automatic identity linking.
 */
const PDF = { 'x-api-contract': 'pdf' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

describe('PDF contract: owner and admin endpoints', () => {
  let h: Harness;
  let owner: Auth;
  let ownerB: Auth;
  let admin: Auth;
  const shopA = () => h.world.a.shopId;
  const shopB = () => h.world.b.shopId;
  const asAuth = async (email: string) => {
    const s = await login(h.app, email);
    return cookieAuth(s.cookie, s.csrf);
  };
  const pdf = (auth: Auth, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) => req(h.app, auth, method, url, body, PDF);
  const body = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
  /** PDF error shape: { code, message, details? } - never the app envelope. */
  const expectPdfError = (r: LightMyRequestResponse, status: number, code: string) => {
    expect(r.statusCode, r.body).toBe(status);
    expect(body(r).code).toBe(code);
    expect(body(r).error).toBeUndefined();
  };

  beforeAll(async () => {
    h = await startHarness({ ORDER_REJECT_ENABLED: 'true' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    owner = await asAuth(h.world.a.ownerEmail);
    ownerB = await asAuth(h.world.b.ownerEmail);
    admin = await asAuth(h.world.adminEmail);
  });

  describe('GET /shops/mine', () => {
    it('returns the PDF paginated shape for the owner, and keeps the app-native shape without the header', async () => {
      const res = await pdf(owner, 'GET', '/shops/mine');
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toMatchObject({ page: 1, limit: 20, total: 1 });
      expect(body(res).items[0]).toEqual({ id: shopA(), shopName: 'Sharma Print', isVerified: false, isOpen: true, isActive: true, ratingAvg: 0, ratingCount: 0 });
      const native = await req(h.app, owner, 'GET', '/shops/mine');
      expect(native.json().data.items[0]).toMatchObject({ id: shopA(), shopName: 'Sharma Print', isDefault: true });
      expect(native.json().data.defaultShopId).toBe(shopA());
    });

    it('is owner-only: 401 INVALID_TOKEN without a session, 403 NOT_SHOP_OWNER for an admin', async () => {
      expectPdfError(await pdf(null, 'GET', '/shops/mine'), 401, 'INVALID_TOKEN');
      expectPdfError(await pdf(admin, 'GET', '/shops/mine'), 403, 'NOT_SHOP_OWNER');
    });
  });

  describe('PATCH /shops/{shopId}', () => {
    it('updates and returns the PDF projection; the app-native twin still answers in its own shape', async () => {
      await h.prisma.shop.update({ where: { id: shopA() }, data: { isVerified: true } });
      const res = await pdf(owner, 'PATCH', `/shops/${shopA()}`, { isOpen: false, upiId: 'ramesh@okbank', acceptedPaymentMethods: ['cash', 'upi'] });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toMatchObject({ id: shopA(), shopName: 'Sharma Print', isOpen: false, upiId: 'ramesh@okbank', acceptedPaymentMethods: ['cash', 'upi'] });
      expect(typeof body(res).updatedAt).toBe('string');
      expect(body(res).data).toBeUndefined();
      const native = await req(h.app, owner, 'PATCH', `/shops/${shopA()}`, { shopName: 'Sharma Print 2' });
      expect(native.statusCode, native.body).toBe(200);
      expect(native.json().data).toMatchObject({ shopName: 'Sharma Print 2', isVerified: true });
    });

    it('rejects admin-only fields, unsupported fields, bad input and opening an unverified shop', async () => {
      const url = `/shops/${shopA()}`;
      expectPdfError(await pdf(owner, 'PATCH', url, { isVerified: true }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'PATCH', url, { isActive: false }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'PATCH', url, { pincode: '12' }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'PATCH', url, { showQr: true }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'PATCH', url, { isOpen: true }), 422, 'SHOP_NOT_VERIFIED');
    });

    it('denies a foreign shop with 403 NOT_SHOP_OWNER (the app-native route keeps its 404)', async () => {
      expectPdfError(await pdf(owner, 'PATCH', `/shops/${shopB()}`, { shopName: 'Hijack' }), 403, 'NOT_SHOP_OWNER');
      expect((await req(h.app, owner, 'PATCH', `/shops/${shopB()}`, { shopName: 'Hijack' })).statusCode).toBe(404);
      expect((await h.prisma.shop.findUniqueOrThrow({ where: { id: shopB() } })).displayName).toBe('Metro Copies');
    });
  });

  describe('PUT /shops/{shopId}/rates', () => {
    const rates = [
      { printingType: 'colored', pricePerPagePaise: 1000 },
      { printingType: 'blackWhite', pricePerPagePaise: 200 }
    ];

    it('maps per-page rates to per-sheet rules (single = P, duplex = 2P), replaces atomically and audits', async () => {
      const res = await pdf(owner, 'PUT', `/shops/${shopA()}/rates`, { rates });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toEqual({
        shopId: shopA(),
        rates: [
          { printingType: 'colored', pricePerPagePaise: 1000, currency: 'INR' },
          { printingType: 'blackWhite', pricePerPagePaise: 200, currency: 'INR' }
        ]
      });
      const rules = await h.prisma.pricingRule.findMany({ where: { shopId: shopA() }, orderBy: [{ colourMode: 'asc' }, { sides: 'asc' }] });
      expect(rules.map((r) => [r.colourMode, r.sides, r.pricePerSheetPaise, r.active])).toEqual([
        ['bw', 'single', 200, true],
        ['bw', 'duplex', 400, true],
        ['colour', 'single', 1000, true],
        ['colour', 'duplex', 2000, true]
      ]);
      expect(await h.prisma.auditLog.count({ where: { shopId: shopA(), action: 'shop.rates.replaced' } })).toBe(1);
      // Replace-all: sending only one type removes the other.
      const only = await pdf(owner, 'PUT', `/shops/${shopA()}/rates`, { rates: [rates[1]] });
      expect(body(only).rates).toHaveLength(1);
      expect(await h.prisma.pricingRule.count({ where: { shopId: shopA() } })).toBe(2);
      // Another tenant's rules are untouched.
      expect(await h.prisma.pricingRule.count({ where: { shopId: shopB() } })).toBe(4);
    });

    it('errors: duplicate type 400, validation 400, foreign shop 403, no session 401', async () => {
      const url = `/shops/${shopA()}/rates`;
      expectPdfError(await pdf(owner, 'PUT', url, { rates: [rates[0], { printingType: 'colored', pricePerPagePaise: 5 }] }), 400, 'DUPLICATE_PRINTING_TYPE');
      expectPdfError(await pdf(owner, 'PUT', url, { rates: [{ printingType: 'sepia', pricePerPagePaise: 5 }] }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'PUT', url, { rates: [{ printingType: 'colored', pricePerPagePaise: 0 }] }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'PUT', url, { rates: [] }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'PUT', `/shops/${shopB()}/rates`, { rates }), 403, 'NOT_SHOP_OWNER');
      expectPdfError(await pdf(null, 'PUT', url, { rates }), 401, 'INVALID_TOKEN');
      expect(await h.prisma.pricingRule.count({ where: { shopId: shopA() } })).toBe(4);
      expect(await h.prisma.pricingRule.count({ where: { shopId: shopB() } })).toBe(4);
    });
  });

  describe('PUT /shops/{shopId}/paper-options', () => {
    it('replaces the options in the PDF shape and denies foreign shops', async () => {
      const res = await pdf(owner, 'PUT', `/shops/${shopA()}/paper-options`, { paperSizes: ['A4'], paperTypes: ['normal'] });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toEqual({ shopId: shopA(), paperSizes: ['A4'], paperTypes: ['normal'] });
      expectPdfError(await pdf(owner, 'PUT', `/shops/${shopB()}/paper-options`, { paperSizes: ['A4'], paperTypes: ['normal'] }), 403, 'NOT_SHOP_OWNER');
      expectPdfError(await pdf(owner, 'PUT', `/shops/${shopA()}/paper-options`, { paperSizes: ['A3'], paperTypes: ['normal'] }), 400, 'UNSUPPORTED_PAPER');
      expect((await req(h.app, owner, 'PUT', `/shops/${shopB()}/paper-options`, { paperSizes: ['A4'], paperTypes: ['normal'] })).statusCode).toBe(404);
    });
  });

  describe('POST /shops/{shopId}/images (fileKey form)', () => {
    async function seedUpload(userId: string, bytes: Buffer = PNG) {
      const storage = createStorage(testConfig());
      const key = generateObjectKey();
      await storage.put(key, Readable.from(bytes), { maxBytes: 10_000_000, contentType: 'image/png' });
      const doc = await createDocument(h.prisma, shopA());
      await h.prisma.document.update({ where: { id: doc.id }, data: { objectKey: key, uploaderUserId: userId } });
      return key;
    }
    const ownerId = async () => (await h.prisma.user.findUniqueOrThrow({ where: { email: h.world.a.ownerEmail } })).id;

    it("links the caller's own upload as a ShopImage; the raw-bytes route keeps working without the header", async () => {
      const key = await seedUpload(await ownerId());
      const res = await pdf(owner, 'POST', `/shops/${shopA()}/images`, { fileKey: key });
      expect(res.statusCode, res.body).toBe(201);
      expect(body(res)).toMatchObject({ sortOrder: 0 });
      expect(body(res).url).toContain(`/shops/${shopA()}/images/`);
      const raw = await h.app.inject({ method: 'POST', url: `/api/v1/shops/${shopA()}/images`, headers: { ...headersFor(owner), 'content-type': 'image/png' }, payload: PNG });
      expect(raw.statusCode, raw.body).toBe(201);
      expect(raw.json().data.sortOrder).toBe(1);
    });

    it('refuses a key that is not the caller\'s upload, a non-image, a foreign shop and a missing session', async () => {
      const foreignKey = await seedUpload((await h.prisma.user.findUniqueOrThrow({ where: { email: h.world.b.ownerEmail } })).id);
      expectPdfError(await pdf(owner, 'POST', `/shops/${shopA()}/images`, { fileKey: foreignKey }), 422, 'FILE_NOT_FOUND');
      expectPdfError(await pdf(owner, 'POST', `/shops/${shopA()}/images`, { fileKey: 'does-not-exist' }), 422, 'FILE_NOT_FOUND');
      const textKey = await seedUpload(await ownerId(), Buffer.from('not an image at all'));
      expectPdfError(await pdf(owner, 'POST', `/shops/${shopA()}/images`, { fileKey: textKey }), 400, 'UNSUPPORTED_FILE_TYPE');
      const okKey = await seedUpload(await ownerId());
      expectPdfError(await pdf(ownerB, 'POST', `/shops/${shopA()}/images`, { fileKey: okKey }), 403, 'NOT_SHOP_OWNER');
      expectPdfError(await pdf(null, 'POST', `/shops/${shopA()}/images`, { fileKey: okKey }), 401, 'INVALID_TOKEN');
      expect(await h.prisma.shopImage.count()).toBe(0);
    });
  });

  describe('GET /shops/{shopId}/orders', () => {
    it('lists the PDF item shape with status mapping, filter and pagination, never a customer phone', async () => {
      const { order } = await newOrder(h.app, h.prisma, h.world.a);
      await newOrder(h.app, h.prisma, h.world.a);
      await newOrder(h.app, h.prisma, h.world.b);
      await h.prisma.order.update({ where: { id: order.id }, data: { paymentMethod: 'CASH' } });
      const res = await pdf(owner, 'GET', `/shops/${shopA()}/orders?status=pending&page=1&limit=1`);
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toMatchObject({ page: 1, limit: 1, total: 2 });
      expect(body(res).items).toHaveLength(1);
      expect(Object.keys(body(res).items[0]).sort()).toEqual(
        ['createdAt', 'copies', 'customerName', 'customerPhone', 'fileName', 'id', 'orderNumber', 'pages', 'paperSize', 'paperType', 'paymentMethod', 'paymentStatus', 'printingType', 'status', 'totalPages', 'totalPaise'].sort()
      );
      expect(body(res).items[0]).toMatchObject({ status: 'pending', customerPhone: null, printingType: 'blackWhite', paperSize: 'A4', paperType: 'normal', paymentStatus: 'unpaid' });
      expect(body(res).items[0].totalPages).toBe(body(res).items[0].pages * body(res).items[0].copies);
      expect(body(await pdf(owner, 'GET', `/shops/${shopA()}/orders?status=accepted`)).total).toBe(0);
      // App-native twin keeps its own shape (raw app statuses).
      const native = await req(h.app, owner, 'GET', `/shops/${shopA()}/orders`);
      expect(native.json().data.items[0].status).toBe('NEW');
    });

    it('validates the status filter and denies foreign shops', async () => {
      expectPdfError(await pdf(owner, 'GET', `/shops/${shopA()}/orders?status=NEW`), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'GET', `/shops/${shopB()}/orders`), 403, 'NOT_SHOP_OWNER');
      expect((await req(h.app, owner, 'GET', `/shops/${shopB()}/orders`)).statusCode).toBe(404);
    });
  });

  describe('PATCH /shops/{shopId}/orders/{orderId}/status', () => {
    it('rejects a pending order with a reason, writes history, and shows the PDF status', async () => {
      const { order } = await newOrder(h.app, h.prisma, h.world.a);
      const url = `/shops/${shopA()}/orders/${order.id}/status`;
      expectPdfError(await pdf(owner, 'PATCH', url, { status: 'rejected' }), 400, 'VALIDATION_ERROR');
      const res = await pdf(owner, 'PATCH', url, { status: 'rejected', rejectReason: 'Out of paper' });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toMatchObject({ id: order.id, status: 'rejected' });
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('REJECTED');
      expect(await h.prisma.orderStatusHistory.count({ where: { orderId: order.id, toStatus: 'REJECTED' } })).toBe(1);
      // Final state: any further change is INVALID_TRANSITION.
      expectPdfError(await pdf(owner, 'PATCH', url, { status: 'accepted' }), 409, 'INVALID_TRANSITION');
    });

    it('refuses transitions outside the PDF flow and those owned by the Print action; unknown values are 400', async () => {
      const { order } = await newOrder(h.app, h.prisma, h.world.a);
      const url = `/shops/${shopA()}/orders/${order.id}/status`;
      expectPdfError(await pdf(owner, 'PATCH', url, { status: 'completed' }), 409, 'INVALID_TRANSITION');
      expectPdfError(await pdf(owner, 'PATCH', url, { status: 'accepted' }), 409, 'INVALID_TRANSITION');
      expectPdfError(await pdf(owner, 'PATCH', url, { status: 'flying' }), 400, 'VALIDATION_ERROR');
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
    });

    it('denies foreign shops and keeps tenants apart', async () => {
      const { order } = await newOrder(h.app, h.prisma, h.world.b);
      expectPdfError(await pdf(owner, 'PATCH', `/shops/${shopB()}/orders/${order.id}/status`, { status: 'rejected', rejectReason: 'x' }), 403, 'NOT_SHOP_OWNER');
      // Own shop id with another tenant's order id is an unknown order.
      expectPdfError(await pdf(owner, 'PATCH', `/shops/${shopA()}/orders/${order.id}/status`, { status: 'rejected', rejectReason: 'x' }), 404, 'ORDER_NOT_FOUND');
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
      void ownerB;
    });
  });

  describe('PATCH /shops/{shopId}/orders/{orderId}/payment', () => {
    it('marks cash paid, then refuses a repeat with 409 INVALID_STATUS', async () => {
      const { order } = await newOrder(h.app, h.prisma, h.world.a);
      await h.prisma.order.update({ where: { id: order.id }, data: { paymentMethod: 'CASH' } });
      const url = `/shops/${shopA()}/orders/${order.id}/payment`;
      const res = await pdf(owner, 'PATCH', url, { paymentStatus: 'paid' });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res)).toEqual({ id: order.id, paymentStatus: 'paid' });
      expectPdfError(await pdf(owner, 'PATCH', url, { paymentStatus: 'paid' }), 409, 'INVALID_STATUS');
      expectPdfError(await pdf(owner, 'PATCH', url, { paymentStatus: 'refunded' }), 400, 'VALIDATION_ERROR');
    });

    it('rejects an unsubmitted UPI payment with 409 INVALID_STATUS and denies foreign shops', async () => {
      const { order } = await newOrder(h.app, h.prisma, h.world.a);
      await h.prisma.order.update({ where: { id: order.id }, data: { paymentMethod: 'UPI' } });
      expectPdfError(await pdf(owner, 'PATCH', `/shops/${shopA()}/orders/${order.id}/payment`, { paymentStatus: 'unpaid' }), 409, 'INVALID_STATUS');
      expectPdfError(await pdf(owner, 'PATCH', `/shops/${shopB()}/orders/${order.id}/payment`, { paymentStatus: 'paid' }), 403, 'NOT_SHOP_OWNER');
      // The app-native twin still returns its richer shape.
      await h.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PENDING_VERIFICATION', upiTxnRef: 'UTR123456789' } });
      const native = await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${order.id}/payment`, { paymentStatus: 'paid' });
      expect(native.json().data).toMatchObject({ id: order.id, paymentMethod: 'upi', paymentStatus: 'paid', upiTxnRef: 'UTR123456789' });
    });
  });

  describe('admin: POST /admin/shops', () => {
    const create = {
      ownerPhoneNumber: '+919811100001',
      ownerName: 'Ramesh',
      shopName: 'Ramesh Printout Point',
      phoneNumber: '+919811100002',
      addressLine1: 'Shop 5, Market',
      city: 'Ghaziabad',
      state: 'UP',
      pincode: '201001',
      latitude: 28.6692,
      longitude: 77.4538,
      rates: [
        { printingType: 'colored', pricePerPagePaise: 1000 },
        { printingType: 'blackWhite', pricePerPagePaise: 200 }
      ]
    };

    it('creates an unverified, closed shop for an UNCLAIMED owner and reuses that owner for the same phone', async () => {
      const res = await pdf(admin, 'POST', '/admin/shops', create);
      expect(res.statusCode, res.body).toBe(201);
      expect(body(res)).toMatchObject({ shopName: 'Ramesh Printout Point', isVerified: false, isActive: true, isOpen: false });
      const ownerUser = await h.prisma.user.findUniqueOrThrow({ where: { id: body(res).ownerId }, include: { memberships: true, phoneIdentity: true } });
      expect(ownerUser.role).toBe('SHOP_OWNER');
      expect(ownerUser.passwordSet).toBe(false);
      expect(ownerUser.phoneIdentity).toBeNull();
      expect(ownerUser.memberships.map((m) => [m.shopId, m.role])).toEqual([[body(res).id, 'OWNER']]);
      expect(await h.prisma.pricingRule.count({ where: { shopId: body(res).id } })).toBe(4);
      expect(await h.prisma.auditLog.count({ where: { shopId: body(res).id, action: 'admin.shop.create' } })).toBe(1);
      const second = await pdf(admin, 'POST', '/admin/shops', { ...create, shopName: 'Ramesh Branch 2' });
      expect(second.statusCode, second.body).toBe(201);
      expect(body(second).ownerId).toBe(body(res).ownerId);
      expect(await h.prisma.user.count({ where: { role: 'SHOP_OWNER' } })).toBe(3);
    });

    it('errors: same name+phone 409 SHOP_ALREADY_EXISTS, validation 400, duplicate rates 400, not admin 403 FORBIDDEN', async () => {
      expect((await pdf(admin, 'POST', '/admin/shops', create)).statusCode).toBe(201);
      expectPdfError(await pdf(admin, 'POST', '/admin/shops', create), 409, 'SHOP_ALREADY_EXISTS');
      expectPdfError(await pdf(admin, 'POST', '/admin/shops', { ...create, shopName: 'Other', pincode: '12' }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(admin, 'POST', '/admin/shops', { ...create, shopName: 'Other', rates: [create.rates[0], create.rates[0]] }), 400, 'DUPLICATE_PRINTING_TYPE');
      expectPdfError(await pdf(admin, 'POST', '/admin/shops', { ...create, shopName: 'Other', acceptedPaymentMethods: ['cash', 'upi'] }), 400, 'VALIDATION_ERROR');
      expectPdfError(await pdf(owner, 'POST', '/admin/shops', { ...create, shopName: 'Other' }), 403, 'FORBIDDEN');
      expectPdfError(await pdf(null, 'POST', '/admin/shops', { ...create, shopName: 'Other' }), 401, 'INVALID_TOKEN');
    });

    it('does not weaken the app-native create (still needs an email + password owner)', async () => {
      const native = await req(h.app, admin, 'POST', '/admin/shops', create);
      expect(native.statusCode).toBe(400);
      expect(native.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('admin: list, verify, block', () => {
    it('lists shops with the isVerified filter in the PDF shape (native keeps cursor pagination)', async () => {
      await h.prisma.shop.update({ where: { id: shopB() }, data: { isVerified: true, city: 'Delhi' } });
      const queue = await pdf(admin, 'GET', '/admin/shops?isVerified=false');
      expect(queue.statusCode, queue.body).toBe(200);
      expect(body(queue)).toMatchObject({ page: 1, limit: 20, total: 1 });
      expect(body(queue).items[0]).toEqual({ id: shopA(), shopName: 'Sharma Print', city: null, isVerified: false, isActive: true });
      expect(body(await pdf(admin, 'GET', '/admin/shops')).total).toBe(2);
      expect(body(await pdf(admin, 'GET', '/admin/shops?isVerified=true')).items[0]).toMatchObject({ id: shopB(), city: 'Delhi', isVerified: true });
      expectPdfError(await pdf(owner, 'GET', '/admin/shops'), 403, 'FORBIDDEN');
      const native = await req(h.app, admin, 'GET', '/admin/shops');
      expect(native.json().data.items[0].displayName).toBeDefined();
    });

    it('verifies, unverifies and blocks with audit; unknown shop is 404 SHOP_NOT_FOUND', async () => {
      const verified = await pdf(admin, 'PATCH', `/admin/shops/${shopA()}/verify`, { isVerified: true });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(body(verified)).toMatchObject({ id: shopA(), isVerified: true });
      expect(typeof body(verified).verifiedAt).toBe('string');
      expect(typeof body(verified).verifiedBy).toBe('string');
      expect(await h.prisma.auditLog.count({ where: { shopId: shopA(), action: 'shop.verify' } })).toBe(1);
      const blocked = await pdf(admin, 'PATCH', `/admin/shops/${shopA()}/block`, { isActive: false });
      expect(blocked.statusCode, blocked.body).toBe(200);
      expect(body(blocked)).toEqual({ id: shopA(), isActive: false });
      expect((await h.prisma.shop.findUniqueOrThrow({ where: { id: shopA() } })).status).toBe('SUSPENDED');
      expect(body(await pdf(admin, 'PATCH', `/admin/shops/${shopA()}/block`, { isActive: true }))).toEqual({ id: shopA(), isActive: true });
      expectPdfError(await pdf(admin, 'PATCH', '/admin/shops/does-not-exist-1/verify', { isVerified: true }), 404, 'SHOP_NOT_FOUND');
      expectPdfError(await pdf(admin, 'PATCH', '/admin/shops/does-not-exist-1/block', { isActive: false }), 404, 'SHOP_NOT_FOUND');
      expectPdfError(await pdf(owner, 'PATCH', `/admin/shops/${shopA()}/verify`, { isVerified: true }), 403, 'FORBIDDEN');
      expectPdfError(await pdf(admin, 'PATCH', `/admin/shops/${shopA()}/verify`, {}), 400, 'VALIDATION_ERROR');
      // Without the header the native response (extra `status`) is unchanged.
      expect((await req(h.app, admin, 'PATCH', `/admin/shops/${shopA()}/block`, { isActive: false })).json().data).toMatchObject({ id: shopA(), isActive: false, status: 'SUSPENDED' });
    });
  });
});
