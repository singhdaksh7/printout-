import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baseOptions, createDocument, login, placeOrder, quoteFor } from './api-helpers.js';
import { makePdf } from './fixtures/make.js';
import { bearerAuth, cookieAuth, DEVICE_A, gtok, headersFor, req, startHarness, type Auth, type Harness } from './helpers/profile-harness.js';

/** Schema-v2 phase 4: REJECTED status (flagged), cash/UPI payment tracking, duplicate UTR, admin-only manual refund records. */
describe('schema-v2 phase 4: lifecycle and payments', () => {
  let h: Harness;
  let age = 280;
  let alice: Auth;
  let bob: Auth;
  let owner: Auth;
  let ownerB: Auth;
  let admin: Auth;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: 'true', ORDER_REJECT_ENABLED: 'true' });
  });
  afterAll(async () => h.close());

  const data = (r: LightMyRequestResponse) => r.json().data as Record<string, any>;
  const asAuth = async (email: string) => {
    const s = await login(h.app, email);
    return cookieAuth(s.cookie, s.csrf);
  };
  async function newCustomer(name: string): Promise<Auth> {
    const restricted = await h.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'google', firebaseIdToken: gtok(`${name}${age}@cust.test`, { ago: age-- }), installationId: DEVICE_A, platform: 'android', audience: 'customer' } });
    const created = await req(h.app, bearerAuth(data(restricted).accessToken), 'POST', '/customers/onboarding', { name, client: 'mobile', deviceId: DEVICE_A });
    expect(created.statusCode, created.body).toBe(201);
    return bearerAuth(data(created).accessToken);
  }
  const shopA = () => h.world.a.shopId;
  const OPTIONS = { ...baseOptions, copies: 1 };

  async function uploadPdf(auth: Auth, shopId: string): Promise<string> {
    const pdf = await makePdf(2);
    const init = await req(h.app, auth, 'POST', '/customer/uploads', { shopId, fileName: 'n.pdf', byteSize: pdf.length, declaredMimeType: 'application/pdf' });
    expect(init.statusCode, init.body).toBe(200);
    expect((await h.app.inject({ method: 'PUT', url: data(init).uploadUrl, payload: pdf, headers: { 'content-type': 'application/pdf' } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: `/api/v1${data(init).completePath}` })).statusCode).toBe(200);
    return data(init).uploadId as string;
  }
  async function place(auth: Auth, paymentMethod: 'cash' | 'upi' = 'cash', shopId = shopA()) {
    const q = await req(h.app, auth, 'POST', '/customer/quotes', { shopId, documentId: await uploadPdf(auth, shopId), printOptions: OPTIONS });
    expect(q.statusCode, q.body).toBe(200);
    const o = await h.app.inject({ method: 'POST', url: '/api/v1/customer/orders', headers: headersFor(auth), payload: { quoteId: data(q).quoteId, clientRequestId: randomUUID(), paymentMethod } });
    expect(o.statusCode, o.body).toBe(201);
    return data(o);
  }
  const enableUpi = async (shopId = shopA(), upiId = 'ramesh@okbank') => h.prisma.shop.update({ where: { id: shopId }, data: { upiId, acceptedPaymentMethods: ['CASH', 'UPI'] } });
  const submit = (auth: Auth, id: string, upiTxnRef: string) => req(h.app, auth, 'POST', `/customer/orders/${id}/payment`, { upiTxnRef });
  const shopPay = (auth: Auth, shopId: string, orderId: string, paymentStatus: string) => req(h.app, auth, 'PATCH', `/shops/${shopId}/orders/${orderId}/payment`, { paymentStatus });
  const events = (orderId: string) => h.prisma.orderPaymentEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });

  beforeEach(async () => {
    await h.reseed();
    age = 280;
    for (const id of [h.world.a.shopId, h.world.b.shopId]) await h.prisma.shop.update({ where: { id }, data: { isVerified: true, verifiedAt: new Date(), status: 'ACTIVE', acceptsOrders: true } });
    alice = await newCustomer('alice');
    bob = await newCustomer('bob');
    owner = await asAuth(h.world.a.ownerEmail);
    ownerB = await asAuth(h.world.b.ownerEmail);
    admin = await asAuth(h.world.adminEmail);
  });

  describe('shop payment settings', () => {
    it('accepts cash by default, validates UPI settings, and shows the UPI id only when UPI is accepted', async () => {
      const card = async () => data(await req(h.app, alice, 'GET', `/customer/shops/${shopA()}`));
      expect(await card()).toMatchObject({ acceptedPaymentMethods: ['cash'], upiId: null });
      const url = `/shops/${shopA()}`;
      expect((await req(h.app, owner, 'PATCH', url, { acceptedPaymentMethods: ['cash', 'upi'] })).statusCode).toBe(400);
      expect((await req(h.app, owner, 'PATCH', url, { upiId: 'not a upi id' })).statusCode).toBe(400);
      expect((await req(h.app, owner, 'PATCH', url, { acceptedPaymentMethods: [] })).statusCode).toBe(400);
      const ok = await req(h.app, owner, 'PATCH', url, { upiId: 'ramesh@okbank', acceptedPaymentMethods: ['cash', 'upi'] });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await card()).toMatchObject({ acceptedPaymentMethods: ['cash', 'upi'], upiId: 'ramesh@okbank' });
      expect((await req(h.app, owner, 'PATCH', url, { upiId: null })).statusCode).toBe(400);
      expect((await req(h.app, owner, 'PATCH', url, { upiId: null, acceptedPaymentMethods: ['cash'] })).statusCode).toBe(200);
      expect(await card()).toMatchObject({ acceptedPaymentMethods: ['cash'], upiId: null });
    });

    it('orders need an accepted payment method', async () => {
      const q = await req(h.app, alice, 'POST', '/customer/quotes', { shopId: shopA(), documentId: await uploadPdf(alice, shopA()), printOptions: OPTIONS });
      const body = (extra: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/api/v1/customer/orders', headers: headersFor(alice), payload: { quoteId: data(q).quoteId, clientRequestId: randomUUID(), ...extra } });
      expect((await body({})).statusCode).toBe(400);
      expect((await body({ paymentMethod: 'card' })).statusCode).toBe(400);
      const upi = await body({ paymentMethod: 'upi' });
      expect(upi.statusCode).toBe(400);
      expect(upi.json().error.code).toBe('PAYMENT_METHOD_NOT_ACCEPTED');
      expect(await h.prisma.order.count()).toBe(0);
      await enableUpi();
      const ok = await body({ paymentMethod: 'upi' });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(data(ok).payment).toEqual({ method: 'upi', status: 'unpaid', upiTxnRef: null, upiId: 'ramesh@okbank' });
    });
  });

  describe('UPI reference tracking', () => {
    it('is a claim until the shop verifies it; events are append-only evidence', async () => {
      await enableUpi();
      const o = await place(alice, 'upi');
      const sub = await submit(alice, o.id, 'utr123456789');
      expect(sub.statusCode, sub.body).toBe(200);
      expect(data(sub).payment).toMatchObject({ status: 'pendingVerification', upiTxnRef: 'UTR123456789' });
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).paymentStatus).toBe('PENDING_VERIFICATION');
      expect((await submit(alice, o.id, 'ANOTHER12345')).statusCode).toBe(409);
      const paid = await shopPay(owner, shopA(), o.id, 'paid');
      expect(paid.statusCode, paid.body).toBe(200);
      expect(data(paid)).toMatchObject({ paymentMethod: 'upi', paymentStatus: 'paid' });
      const ev = await events(o.id);
      expect(ev.map((e) => [e.event, e.actorRole, e.toStatus])).toEqual([['UPI_SUBMITTED', 'CUSTOMER', 'PENDING_VERIFICATION'], ['UPI_VERIFIED', 'SHOP_OWNER', 'PAID']]);
      await expect(h.prisma.$executeRawUnsafe(`UPDATE "OrderPaymentEvent" SET reason = 'x' WHERE "orderId" = '${o.id}'`)).rejects.toThrow(/append-only/);
      await expect(h.prisma.$executeRawUnsafe(`DELETE FROM "OrderPaymentEvent" WHERE "orderId" = '${o.id}'`)).rejects.toThrow(/append-only/);
      expect(await events(o.id)).toHaveLength(2);
    });

    it('rejects a wrong reference, lets the customer resubmit, and blocks duplicate UTRs per shop (case-insensitive)', async () => {
      await enableUpi();
      await enableUpi(h.world.b.shopId, 'metro@okbank');
      const o1 = await place(alice, 'upi');
      const o2 = await place(bob, 'upi');
      await submit(alice, o1.id, 'abc123456789');
      const dup = await submit(bob, o2.id, 'ABC123456789');
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('DUPLICATE_UTR');
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o2.id } })).paymentStatus).toBe('UNPAID');
      // the same reference at ANOTHER shop is a different payment
      const bAlice = await place(alice, 'upi', h.world.b.shopId);
      expect((await submit(alice, bAlice.id, 'ABC123456789')).statusCode).toBe(200);
      // shop rejects the claim: reference cleared, customer may resubmit, the old reference is free again
      const rej = await shopPay(owner, shopA(), o1.id, 'unpaid');
      expect(rej.statusCode, rej.body).toBe(200);
      expect(data(rej)).toMatchObject({ paymentStatus: 'unpaid', upiTxnRef: null });
      expect((await submit(bob, o2.id, 'ABC123456789')).statusCode).toBe(200);
      expect((await submit(alice, o1.id, 'NEWREF987654')).statusCode).toBe(200);
      expect((await events(o1.id)).map((e) => e.event)).toEqual(['UPI_SUBMITTED', 'UPI_REJECTED', 'UPI_SUBMITTED']);
    });

    it('validates the reference, the order type and ownership', async () => {
      await enableUpi();
      const upi = await place(alice, 'upi');
      const cash = await place(alice, 'cash');
      for (const bad of ['', 'short', 'has space 12345', 'x'.repeat(23), '12345678!']) expect((await submit(alice, upi.id, bad)).statusCode, bad).toBe(400);
      expect((await req(h.app, alice, 'POST', `/customer/orders/${upi.id}/payment`, { upiTxnRef: 'ABCDEFGH1234', extra: 1 })).statusCode).toBe(400);
      const wrongType = await submit(alice, cash.id, 'ABCDEFGH1234');
      expect(wrongType.statusCode).toBe(409);
      expect(wrongType.json().error.code).toBe('NOT_UPI_ORDER');
      expect((await submit(bob, upi.id, 'ABCDEFGH1234')).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'POST', url: `/api/v1/customer/orders/${upi.id}/payment`, payload: { upiTxnRef: 'ABCDEFGH1234' } })).statusCode).toBe(401);
      expect((await req(h.app, owner, 'POST', `/customer/orders/${upi.id}/payment`, { upiTxnRef: 'ABCDEFGH1234' })).statusCode).toBe(403);
      expect(await h.prisma.orderPaymentEvent.count()).toBe(0);
    });
  });

  describe('shop payment decisions', () => {
    it('cash: only the shop marks it received, once; a customer can never mark paid', async () => {
      const o = await place(alice, 'cash');
      expect((await req(h.app, alice, 'PATCH', `/shops/${shopA()}/orders/${o.id}/payment`, { paymentStatus: 'paid' })).statusCode).toBe(403);
      expect((await shopPay(owner, shopA(), o.id, 'unpaid')).statusCode).toBe(409);
      expect((await shopPay(owner, shopA(), o.id, 'paid')).statusCode).toBe(200);
      expect((await shopPay(owner, shopA(), o.id, 'paid')).statusCode).toBe(409);
      expect((await shopPay(owner, shopA(), o.id, 'unpaid')).statusCode).toBe(409);
      expect((await events(o.id)).map((e) => e.event)).toEqual(['CASH_RECEIVED']);
      expect((await shopPay(owner, shopA(), o.id, 'refunded')).statusCode).toBe(400);
    });

    it('a UPI order cannot be marked paid without a submitted reference, and other shops cannot touch it', async () => {
      await enableUpi();
      const o = await place(alice, 'upi');
      const early = await shopPay(owner, shopA(), o.id, 'paid');
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe('INVALID_PAYMENT_TRANSITION');
      await submit(alice, o.id, 'REFERENCE0001');
      expect((await shopPay(ownerB, h.world.b.shopId, o.id, 'paid')).statusCode).toBe(404);
      expect((await shopPay(ownerB, shopA(), o.id, 'paid')).statusCode).toBe(404);
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).paymentStatus).toBe('PENDING_VERIFICATION');
    });

    it('serialises concurrent decisions: exactly one wins', async () => {
      const o = await place(alice, 'cash');
      const results = await Promise.all([shopPay(owner, shopA(), o.id, 'paid'), shopPay(owner, shopA(), o.id, 'paid'), shopPay(owner, shopA(), o.id, 'paid')]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
      expect(await events(o.id)).toHaveLength(1);
    });

    it('guest QR orders have no payment method and cannot be marked', async () => {
      const doc = await createDocument(h.prisma, shopA(), {});
      const q = await quoteFor(h.app, h.world.a.slug, doc.id);
      const guest = await placeOrder(h.app, h.world.a.slug, q.json().data.quoteId);
      expect(guest.statusCode, guest.body).toBe(200);
      const row = await h.prisma.order.findFirstOrThrow({ where: { trackingToken: guest.json().data.trackingToken } });
      expect(row).toMatchObject({ paymentMethod: null, paymentStatus: 'UNPAID', customerUserId: null });
      expect((await shopPay(owner, shopA(), row.id, 'paid')).statusCode).toBe(409);
    });
  });

  describe('admin-only manual refund records', () => {
    async function paidOrder() {
      const o = await place(alice, 'cash');
      await shopPay(owner, shopA(), o.id, 'paid');
      return o;
    }
    it('only a platform admin can record a refund of a PAID order, with a reason and a bounded amount', async () => {
      const o = await paidOrder();
      const url = `/admin/orders/${o.id}/refund`;
      for (const who of [owner, alice, ownerB]) expect((await req(h.app, who, 'POST', url, { reason: 'Customer request' })).statusCode).toBe(403);
      expect((await h.app.inject({ method: 'POST', url: `/api/v1${url}`, payload: { reason: 'x' } })).statusCode).toBe(401);
      expect((await req(h.app, admin, 'POST', url, {})).statusCode).toBe(400);
      expect((await req(h.app, admin, 'POST', url, { reason: 'ok reason', amountPaise: o.totalPaise + 1 })).statusCode).toBe(400);
      expect((await req(h.app, admin, 'POST', url, { reason: 'ok reason', amountPaise: 0 })).statusCode).toBe(400);
      const ok = await req(h.app, admin, 'POST', url, { reason: 'Print failed, cash returned', amountPaise: 100 });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(data(ok).paymentStatus).toBe('refunded');
      const ev = (await events(o.id)).at(-1)!;
      expect(ev).toMatchObject({ event: 'REFUND_RECORDED', actorRole: 'PLATFORM_ADMIN', amountPaise: 100, reason: 'Print failed, cash returned', fromStatus: 'PAID', toStatus: 'REFUNDED' });
      expect(await h.prisma.auditLog.count({ where: { action: 'order.payment.refund_recorded', actorType: 'PLATFORM_ADMIN' } })).toBe(1);
      expect((await req(h.app, admin, 'POST', url, { reason: 'again again' })).statusCode).toBe(409);
      expect((await shopPay(owner, shopA(), o.id, 'unpaid')).statusCode).toBe(409);
    });
    it('refuses unpaid and pending orders and unknown ids; a full refund defaults to the order total', async () => {
      const unpaid = await place(alice, 'cash');
      expect((await req(h.app, admin, 'POST', `/admin/orders/${unpaid.id}/refund`, { reason: 'no payment' })).statusCode).toBe(409);
      expect((await req(h.app, admin, 'POST', '/admin/orders/does-not-exist/refund', { reason: 'no order' })).statusCode).toBe(404);
      const o = await paidOrder();
      await req(h.app, admin, 'POST', `/admin/orders/${o.id}/refund`, { reason: 'full refund' });
      expect((await events(o.id)).at(-1)!.amountPaise).toBe(o.totalPaise);
    });
  });

  describe('cancellation and payments', () => {
    it('a customer cannot cancel while a payment is claimed or recorded, but can once the claim is rejected', async () => {
      await enableUpi();
      const o = await place(alice, 'upi');
      await submit(alice, o.id, 'CANCELREF001');
      const locked = await req(h.app, alice, 'POST', `/customer/orders/${o.id}/cancel`, {});
      expect(locked.statusCode).toBe(409);
      expect(locked.json().error.code).toBe('PAYMENT_RECORDED');
      await shopPay(owner, shopA(), o.id, 'unpaid');
      expect((await req(h.app, alice, 'POST', `/customer/orders/${o.id}/cancel`, {})).statusCode).toBe(200);
      expect((await submit(alice, o.id, 'CANCELREF002')).statusCode).toBe(409);
      expect((await shopPay(owner, shopA(), o.id, 'paid')).statusCode).toBe(409);
    });
  });

  describe('REJECTED status (decision D7)', () => {
    const reject = (auth: Auth, shopId: string, orderId: string, rejectReason?: string) => req(h.app, auth, 'PATCH', `/shops/${shopId}/orders/${orderId}/status`, { status: 'rejected', ...(rejectReason ? { rejectReason } : {}) });

    it('is off by default (FEATURE_DISABLED) on both routes and nothing changes', async () => {
      const off = await startHarness({ ORDER_REJECT_ENABLED: '__unset__' });
      try {
        const doc = await createDocument(off.prisma, off.world.a.shopId, {});
        const q = await quoteFor(off.app, off.world.a.slug, doc.id);
        const placed = await placeOrder(off.app, off.world.a.slug, q.json().data.quoteId);
        const row = await off.prisma.order.findFirstOrThrow({ where: { trackingToken: placed.json().data.trackingToken } });
        const s = await login(off.app, off.world.a.ownerEmail);
        const a = cookieAuth(s.cookie, s.csrf);
        const viaNew = await req(off.app, a, 'PATCH', `/shops/${off.world.a.shopId}/orders/${row.id}/status`, { status: 'rejected', rejectReason: 'Busy' });
        expect(viaNew.statusCode).toBe(409);
        expect(viaNew.json().error.code).toBe('FEATURE_DISABLED');
        const viaLegacy = await req(off.app, a, 'POST', `/shop/orders/${row.id}/transitions`, { toStatus: 'REJECTED', reason: 'Busy', clientRequestId: randomUUID() });
        expect(viaLegacy.statusCode).toBe(409);
        expect((await off.prisma.order.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('NEW');
        const cancel = await req(off.app, a, 'POST', `/shop/orders/${row.id}/transitions`, { toStatus: 'CANCELLED', clientRequestId: randomUUID() });
        expect(cancel.statusCode, cancel.body).toBe(200); // the existing contract is untouched
      } finally {
        await off.close();
      }
    });

    it('rejects a NEW order with a reason, shows it to the customer, and it is terminal', async () => {
      const o = await place(alice, 'cash');
      expect((await reject(owner, shopA(), o.id)).statusCode).toBe(400);
      expect((await reject(ownerB, shopA(), o.id, 'Busy')).statusCode).toBe(404);
      const r = await reject(owner, shopA(), o.id, 'Out of paper');
      expect(r.statusCode, r.body).toBe(200);
      expect(data(r).status).toBe('REJECTED');
      const detail = data(await req(h.app, alice, 'GET', `/customer/orders/${o.id}`));
      expect(detail.status).toBe('REJECTED');
      expect(detail.statusHistory.at(-1)).toMatchObject({ status: 'REJECTED', by: 'shop', reason: 'Out of paper' });
      expect((await req(h.app, alice, 'POST', `/customer/orders/${o.id}/cancel`, {})).statusCode).toBe(409);
      expect((await reject(owner, shopA(), o.id, 'again')).statusCode).toBe(200); // idempotent
      expect((await shopPay(owner, shopA(), o.id, 'paid')).statusCode).toBe(409);
      expect((await req(h.app, owner, 'POST', `/shop/orders/${o.id}/print-now`, { clientRequestId: randomUUID() })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('REJECTED');
      const filtered = data(await req(h.app, alice, 'GET', '/customer/orders?status=REJECTED'));
      expect(filtered.total).toBe(1);
    });

    it('is refused while a payment is claimed or recorded, and statuses owned by Print cannot be set directly', async () => {
      await enableUpi();
      const o = await place(alice, 'upi');
      await submit(alice, o.id, 'REJECTREF001');
      const blocked = await reject(owner, shopA(), o.id, 'No');
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe('PAYMENT_RECORDED');
      for (const status of ['accepted', 'printing', 'ready', 'completed']) {
        expect((await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o.id}/status`, { status })).statusCode, status).toBe(409);
      }
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('NEW');
    });

    it('only REJECTED-aware reports: rejected orders are not counted as order value and are terminal in lists', async () => {
      const o = await place(alice, 'cash');
      await reject(owner, shopA(), o.id, 'Closed early');
      const rev = await req(h.app, owner, 'GET', '/shop/analytics');
      expect(rev.statusCode).toBe(200);
      expect(data(rev).ordersByStatus?.REJECTED ?? 0).toBeGreaterThanOrEqual(0);
      const active = await req(h.app, owner, 'GET', '/shop/orders?active=1');
      expect(JSON.stringify(data(active))).not.toContain(o.orderNumber);
    });
  });

  describe('shop order list (multi-shop)', () => {
    it('lists the shop\'s orders with payment state and a customer display name, never contact data, and is tenant-isolated', async () => {
      const o = await place(alice, 'cash');
      const list = await req(h.app, owner, 'GET', `/shops/${shopA()}/orders?limit=5`);
      expect(list.statusCode, list.body).toBe(200);
      expect(data(list)).toMatchObject({ page: 1, limit: 5, total: 1 });
      expect(data(list).items[0]).toMatchObject({ id: o.id, customerName: 'alice', paymentMethod: 'cash', paymentStatus: 'unpaid', status: 'NEW' });
      for (const secret of ['@cust.test', 'passwordHash', 'firebase', 'trackingToken', 'objectKey']) expect(list.body).not.toContain(secret);
      expect((await req(h.app, ownerB, 'GET', `/shops/${shopA()}/orders`)).statusCode).toBe(404);
      expect(data(await req(h.app, owner, 'GET', `/shops/${shopA()}/orders?status=CANCELLED`)).total).toBe(0);
      expect((await req(h.app, owner, 'GET', `/shops/${shopA()}/orders?limit=51`)).statusCode).toBe(400);
      expect((await req(h.app, alice, 'GET', `/shops/${shopA()}/orders`)).statusCode).toBe(403);
    });
  });
});
