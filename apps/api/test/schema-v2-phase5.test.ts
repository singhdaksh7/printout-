import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCustomerNotification } from '../src/domain/customer-notifications.js';
import { publicName } from '../src/routes/customer-reviews.js';
import { baseOptions, createDocument, login, placeOrder, quoteFor } from './api-helpers.js';
import { makePdf } from './fixtures/make.js';
import { bearerAuth, cookieAuth, DEVICE_A, FakePushSender, gtok, headersFor, req, sleep, startHarness, type Auth, type Harness } from './helpers/profile-harness.js';

/** Schema-v2 phase 5: reviews and ratings, customer notification inbox, customer/shop push. FakePushSender only: no real FCM. */
const TOKEN_ALICE = 'fcm-alice-phone-0123456789-abcdefghijklmnopqrstuvwxyz';
const TOKEN_BOB = 'fcm-bob-phone-00123456789-abcdefghijklmnopqrstuvwxyz';
const TOKEN_OWNER = 'fcm-owner-phone-0123456789-abcdefghijklmnopqrstuvwxyz';

describe('schema-v2 phase 5: reviews and notifications', () => {
  const sender = new FakePushSender();
  let h: Harness;
  let age = 280;
  let alice: Auth;
  let bob: Auth;
  let owner: Auth;
  let ownerB: Auth;
  let admin: Auth;
  let aliceId: string;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: 'true', ORDER_REJECT_ENABLED: 'true', FCM_PUSH_ENABLED: 'true', FCM_FAILURE_REVOKE_AFTER: '2' }, undefined, { pushSender: sender });
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

  async function place(auth: Auth, shopId = shopA(), paymentMethod: 'cash' | 'upi' = 'cash') {
    const pdf = await makePdf(2);
    const init = await req(h.app, auth, 'POST', '/customer/uploads', { shopId, fileName: 'private-name.pdf', byteSize: pdf.length, declaredMimeType: 'application/pdf' });
    expect((await h.app.inject({ method: 'PUT', url: data(init).uploadUrl, payload: pdf, headers: { 'content-type': 'application/pdf' } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: `/api/v1${data(init).completePath}` })).statusCode).toBe(200);
    const q = await req(h.app, auth, 'POST', '/customer/quotes', { shopId, documentId: data(init).uploadId, printOptions: { ...baseOptions, copies: 1 } });
    const o = await h.app.inject({ method: 'POST', url: '/api/v1/customer/orders', headers: headersFor(auth), payload: { quoteId: data(q).quoteId, clientRequestId: randomUUID(), paymentMethod } });
    expect(o.statusCode, o.body).toBe(201);
    return data(o);
  }
  const setStatus = (id: string, status: string) => h.prisma.order.update({ where: { id }, data: { status: status as never } });
  const review = (auth: Auth, orderId: string, rating: unknown, extra: Record<string, unknown> = {}) => req(h.app, auth, 'POST', '/customer/reviews', { orderId, rating, ...extra });
  const settled = async (calls: number) => {
    await vi.waitFor(() => expect(sender.calls.length).toBe(calls), { timeout: 5000, interval: 25 });
    await sleep(120);
    expect(sender.calls.length).toBe(calls);
  };
  const register = async (auth: Auth, installationId: string, token: string) => expect((await req(h.app, auth, 'PUT', '/users/me/fcm-token', { installationId, token, platform: 'android' })).statusCode).toBe(200);
  const inbox = async (auth: Auth, q = '') => data(await req(h.app, auth, 'GET', `/customer/notifications${q}`));

  beforeEach(async () => {
    await h.reseed();
    sender.reset();
    age = 280;
    for (const id of [h.world.a.shopId, h.world.b.shopId]) await h.prisma.shop.update({ where: { id }, data: { isVerified: true, verifiedAt: new Date(), status: 'ACTIVE', acceptsOrders: true } });
    const a = await newCustomer('Alice Banerjee');
    alice = a.auth;
    aliceId = a.id;
    bob = (await newCustomer('Bob')).auth;
    owner = await asAuth(h.world.a.ownerEmail);
    ownerB = await asAuth(h.world.b.ownerEmail);
    admin = await asAuth(h.world.adminEmail);
  });

  describe('reviews and ratings', () => {
    it('needs a started print, records one review, and maintains an exact aggregate', async () => {
      const o1 = await place(alice);
      const early = await review(alice, o1.id, 5);
      expect(early.statusCode).toBe(422);
      expect(early.json().error.code).toBe('ORDER_NOT_COMPLETED');
      await setStatus(o1.id, 'PRINTING');
      const ok = await review(alice, o1.id, 5, { comment: '  Fast and clean print  ' });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(data(ok)).toMatchObject({ orderId: o1.id, shopId: shopA(), rating: 5, comment: 'Fast and clean print' });
      const o2 = await place(bob);
      await setStatus(o2.id, 'COLLECTED');
      expect((await review(bob, o2.id, 2)).statusCode).toBe(201);
      const o3 = await place(bob);
      await setStatus(o3.id, 'READY');
      expect((await review(bob, o3.id, 2, { comment: '   ' })).statusCode).toBe(201);
      const shop = await h.prisma.shop.findUniqueOrThrow({ where: { id: shopA() } });
      expect(shop).toMatchObject({ ratingCount: 3, ratingSum: 9, ratingAvg: 3 });
      const avg = await h.prisma.$queryRaw<Array<{ a: number; n: bigint }>>`SELECT round(avg("rating")::numeric, 1)::float AS a, count(*) AS n FROM "Review" WHERE "shopId" = ${shopA()}`;
      expect(avg[0]!.a).toBe(shop.ratingAvg);
      expect(Number(avg[0]!.n)).toBe(shop.ratingCount);
      expect((await h.prisma.review.findFirstOrThrow({ where: { orderId: o3.id } })).comment).toBeNull();
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o1.id } })).isReviewed).toBe(true);
      const card = data(await req(h.app, bob, 'GET', `/customer/shops/${shopA()}`));
      expect(card).toMatchObject({ ratingAvg: 3, ratingCount: 3 });
      expect(data(await req(h.app, alice, 'GET', `/customer/orders/${o1.id}`)).isReviewed).toBe(true);
      expect(await h.prisma.auditLog.count({ where: { action: 'review.created', actorType: 'CUSTOMER' } })).toBe(3);
    });

    it('rounds the stored average to one decimal and keeps no rating for an unreviewed shop', async () => {
      const card = data(await req(h.app, alice, 'GET', `/customer/shops/${shopA()}`));
      expect(card).toMatchObject({ ratingAvg: null, ratingCount: 0 });
      for (const rating of [5, 4, 4]) {
        const o = await place(rating === 5 ? alice : bob);
        await setStatus(o.id, 'PRINTED');
        expect((await review(rating === 5 ? alice : bob, o.id, rating)).statusCode).toBe(201);
      }
      expect((await h.prisma.shop.findUniqueOrThrow({ where: { id: shopA() } })).ratingAvg).toBe(4.3); // 13 / 3
    });

    it('allows exactly one review per order, even under concurrency', async () => {
      const o = await place(alice);
      await setStatus(o.id, 'COLLECTED');
      const results = await Promise.all([review(alice, o.id, 5), review(alice, o.id, 1), review(alice, o.id, 3)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe('REVIEW_EXISTS');
      const shop = await h.prisma.shop.findUniqueOrThrow({ where: { id: shopA() } });
      expect(shop.ratingCount).toBe(1);
      expect(await h.prisma.review.count()).toBe(1);
      expect(shop.ratingSum).toBe((await h.prisma.review.findFirstOrThrow()).rating);
    });

    it('is bound to the order\'s customer: others get 404, owners and admins 403, anonymous 401', async () => {
      const o = await place(alice);
      await setStatus(o.id, 'COLLECTED');
      expect((await review(bob, o.id, 5)).statusCode).toBe(404);
      expect((await review(owner, o.id, 5)).statusCode).toBe(403);
      expect((await review(admin, o.id, 5)).statusCode).toBe(403);
      expect((await h.app.inject({ method: 'POST', url: '/api/v1/customer/reviews', payload: { orderId: o.id, rating: 5 } })).statusCode).toBe(401);
      expect((await review(alice, 'does-not-exist', 5)).statusCode).toBe(404);
      expect(await h.prisma.review.count()).toBe(0);
      expect((await h.prisma.shop.findUniqueOrThrow({ where: { id: shopA() } })).ratingCount).toBe(0);
    });

    it('refuses cancelled, rejected and expired orders and invalid input', async () => {
      for (const status of ['CANCELLED', 'REJECTED', 'EXPIRED', 'NEW', 'ACCEPTED']) {
        const o = await place(alice);
        await setStatus(o.id, status);
        expect((await review(alice, o.id, 5)).statusCode, status).toBe(422);
      }
      const o = await place(alice);
      await setStatus(o.id, 'COLLECTED');
      for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 1.5 }, { rating: '5' }, { rating: 5, comment: 'x'.repeat(1001) }, { rating: 5, comment: 'bad\u0007char' }, { rating: 5, extra: 1 }, { rating: 5, customerUserId: 'x' }, {}]) {
        const res = await req(h.app, alice, 'POST', '/customer/reviews', { orderId: o.id, ...bad });
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect(await h.prisma.review.count()).toBe(0);
      const html = await review(alice, o.id, 4, { comment: '<script>alert(1)</script>' });
      expect(html.statusCode).toBe(201);
      expect(data(html).comment).toBe('<script>alert(1)</script>'); // stored and returned as plain text; clients escape on display
    });

    it('enforces rating and uniqueness in the database too', async () => {
      const o = await place(alice);
      await expect(h.prisma.$executeRawUnsafe(`INSERT INTO "Review"(id,"orderId","customerUserId","shopId",rating) VALUES ('rv1','${o.id}','${aliceId}','${shopA()}',9)`)).rejects.toThrow();
      await h.prisma.review.create({ data: { orderId: o.id, customerUserId: aliceId, shopId: shopA(), rating: 3 } });
      await expect(h.prisma.review.create({ data: { orderId: o.id, customerUserId: aliceId, shopId: shopA(), rating: 4 } })).rejects.toThrow();
    });

    it('lists reviews newest first with abbreviated names, for customers (verified shops only) and owners (own shop only)', async () => {
      const o1 = await place(alice);
      await setStatus(o1.id, 'COLLECTED');
      await review(alice, o1.id, 5, { comment: 'Great' });
      await sleep(20);
      const o2 = await place(bob);
      await setStatus(o2.id, 'COLLECTED');
      await review(bob, o2.id, 3);
      const list = data(await req(h.app, bob, 'GET', `/customer/shops/${shopA()}/reviews?limit=1`));
      expect(list).toMatchObject({ page: 1, limit: 1, total: 2, ratingAvg: 4, ratingCount: 2 });
      expect(list.items).toMatchObject([{ rating: 3, customerName: 'Bob' }]);
      const page2 = data(await req(h.app, bob, 'GET', `/customer/shops/${shopA()}/reviews?limit=1&page=2`));
      expect(page2.items).toMatchObject([{ rating: 5, comment: 'Great', customerName: 'Alice B.' }]);
      for (const secret of [aliceId, '@cust.test', 'customerUserId', 'orderId']) expect(JSON.stringify(page2)).not.toContain(secret);
      const ownerView = data(await req(h.app, owner, 'GET', `/shops/${shopA()}/reviews`));
      expect(ownerView.total).toBe(2);
      expect((await req(h.app, ownerB, 'GET', `/shops/${shopA()}/reviews`)).statusCode).toBe(404);
      await h.prisma.shop.update({ where: { id: shopA() }, data: { isVerified: false } });
      expect((await req(h.app, bob, 'GET', `/customer/shops/${shopA()}/reviews`)).statusCode).toBe(404);
      expect((await req(h.app, bob, 'GET', `/customer/shops/${h.world.b.shopId}/reviews?limit=51`)).statusCode).toBe(400);
      expect(publicName('  rahul   kumar ')).toBe('rahul K.');
      expect(publicName('')).toBe('Customer');
    });

    it('has no edit or delete route in v1', async () => {
      const o = await place(alice);
      await setStatus(o.id, 'COLLECTED');
      const r = data(await review(alice, o.id, 5));
      for (const method of ['PATCH', 'PUT', 'DELETE'] as const) expect((await req(h.app, alice, method, `/customer/reviews/${r.id}`, {})).statusCode).toBe(404);
    });
  });

  describe('customer notification inbox', () => {
    it('records order and payment events for the customer only, with generic texts, and nothing for guests or self-cancel', async () => {
      const o = await place(alice);
      await h.prisma.shop.update({ where: { id: shopA() }, data: { upiId: 'ramesh@okbank', acceptedPaymentMethods: ['CASH', 'UPI'] } });
      const rej = await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o.id}/status`, { status: 'rejected', rejectReason: 'Busy' });
      expect(rej.statusCode, rej.body).toBe(200);
      const list = await inbox(alice);
      expect(list).toMatchObject({ total: 1, unreadCount: 1 });
      expect(list.items[0]).toMatchObject({ type: 'orderStatus', title: 'Order rejected', orderId: o.id, readAt: null });
      expect(list.items[0].body).toContain(o.orderNumber);
      for (const secret of ['private-name', 'Busy', 'ramesh', '@cust.test', String(o.totalPaise)]) expect(JSON.stringify(list)).not.toContain(secret);
      expect((await inbox(bob)).total).toBe(0);
      // self-cancel produces no notification
      const o2 = await place(alice);
      await req(h.app, alice, 'POST', `/customer/orders/${o2.id}/cancel`, {});
      expect((await inbox(alice)).total).toBe(1);
      // a guest order never creates a customer row and never fails
      const doc = await createDocument(h.prisma, shopA(), {});
      const gq = await quoteFor(h.app, h.world.a.slug, doc.id);
      const guest = await placeOrder(h.app, h.world.a.slug, gq.json().data.quoteId);
      const g = await h.prisma.order.findFirstOrThrow({ where: { trackingToken: guest.json().data.trackingToken } });
      expect((await req(h.app, owner, 'POST', `/shop/orders/${g.id}/transitions`, { toStatus: 'CANCELLED', clientRequestId: randomUUID() })).statusCode).toBe(200);
      expect(await h.prisma.userNotification.count()).toBe(1);
    });

    it('notifies on print start, payment paid / reference rejected (each time) and refund, idempotently', async () => {
      await h.prisma.shop.update({ where: { id: shopA() }, data: { upiId: 'ramesh@okbank', acceptedPaymentMethods: ['CASH', 'UPI'] } });
      const o = await place(alice, shopA(), 'upi');
      await req(h.app, alice, 'POST', `/customer/orders/${o.id}/payment`, { upiTxnRef: 'NOTIFYREF001' });
      await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o.id}/payment`, { paymentStatus: 'unpaid' });
      await req(h.app, alice, 'POST', `/customer/orders/${o.id}/payment`, { upiTxnRef: 'NOTIFYREF002' });
      await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o.id}/payment`, { paymentStatus: 'unpaid' });
      await req(h.app, alice, 'POST', `/customer/orders/${o.id}/payment`, { upiTxnRef: 'NOTIFYREF003' });
      await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o.id}/payment`, { paymentStatus: 'paid' });
      const pr = await req(h.app, owner, 'POST', `/shop/orders/${o.id}/print-now`, { clientRequestId: randomUUID() });
      expect(pr.statusCode, pr.body).toBe(200);
      await req(h.app, admin, 'POST', `/admin/orders/${o.id}/refund`, { reason: 'Printer jammed' });
      const titles = (await inbox(alice, '?limit=50')).items.map((n: any) => n.title).sort();
      expect(titles).toEqual(['Payment received', 'Payment reference not accepted', 'Payment reference not accepted', 'Printing started', 'Refund recorded'].sort());
      // replaying the same event is a no-op
      const row = await h.prisma.userNotification.findFirstOrThrow({ where: { title: 'Printing started' } });
      const again = await recordCustomerNotification(h.prisma, { customerUserId: aliceId, event: 'order.printing', orderId: o.id, orderNumber: o.orderNumber });
      expect(again!.id).toBe(row.id);
      expect(await h.prisma.userNotification.count({ where: { userId: aliceId } })).toBe(5);
      expect(await recordCustomerNotification(h.prisma, { customerUserId: null, event: 'order.expired', orderId: o.id, orderNumber: o.orderNumber })).toBeNull();
    });

    it('lists, filters unread, marks read idempotently and never touches another user\'s rows', async () => {
      for (const ev of ['order.rejected', 'order.cancelled', 'order.printing'] as const) {
        const o = await place(alice);
        await recordCustomerNotification(h.prisma, { customerUserId: aliceId, event: ev, orderId: o.id, orderNumber: o.orderNumber });
        await sleep(5);
      }
      const all = await inbox(alice, '?limit=2');
      expect(all).toMatchObject({ page: 1, limit: 2, total: 3, unreadCount: 3 });
      expect(all.items).toHaveLength(2);
      const id = all.items[0].id as string;
      expect((await req(h.app, bob, 'POST', `/customer/notifications/${id}/read`, {})).statusCode).toBe(404);
      expect((await req(h.app, alice, 'POST', `/customer/notifications/${id}/read`, {})).statusCode).toBe(204);
      const first = (await h.prisma.userNotification.findUniqueOrThrow({ where: { id } })).readAt!;
      await sleep(15);
      expect((await req(h.app, alice, 'POST', `/customer/notifications/${id}/read`, {})).statusCode).toBe(204);
      expect((await h.prisma.userNotification.findUniqueOrThrow({ where: { id } })).readAt!.getTime()).toBe(first.getTime());
      expect((await inbox(alice, '?unread=true')).total).toBe(2);
      expect((await inbox(alice)).unreadCount).toBe(2);
      expect(data(await req(h.app, bob, 'POST', '/customer/notifications/read-all', {})).updated).toBe(0);
      expect((await inbox(alice)).unreadCount).toBe(2);
      expect(data(await req(h.app, alice, 'POST', '/customer/notifications/read-all', {})).updated).toBe(2);
      expect((await inbox(alice)).unreadCount).toBe(0);
      expect((await req(h.app, alice, 'GET', '/customer/notifications?limit=51')).statusCode).toBe(400);
      for (const who of [owner, admin]) expect((await req(h.app, who, 'GET', '/customer/notifications')).statusCode).toBe(403);
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/customer/notifications' })).statusCode).toBe(401);
    });
  });

  describe('push delivery (FakePushSender)', () => {
    it('pushes only to the order\'s customer devices, after commit, with a minimal payload', async () => {
      await register(alice, 'install-alice-0000000001', TOKEN_ALICE);
      await register(bob, 'install-bob-000000000001', TOKEN_BOB);
      await register(owner, 'install-owner-00000000001', TOKEN_OWNER);
      const o = await place(alice);
      await settled(1); // the new-order push to the shop owner
      expect(sender.calls[0]!.tokens).toEqual([TOKEN_OWNER]);
      sender.reset();
      const rej = await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o.id}/status`, { status: 'rejected', rejectReason: 'Out of paper' });
      expect(rej.statusCode, rej.body).toBe(200);
      await settled(1);
      expect(sender.calls[0]!.tokens).toEqual([TOKEN_ALICE]);
      expect(sender.calls[0]!.message).toEqual({ type: 'order.updated', orderId: o.id, title: 'Order rejected' });
      expect(JSON.stringify(sender.calls)).not.toMatch(/private-name|Out of paper|@cust|Alice/);
      expect(sender.allTokens).not.toContain(TOKEN_BOB);
      expect(sender.allTokens).not.toContain(TOKEN_OWNER);
    });

    it('notifies the shop owners (not customers) when a customer submits a UPI reference', async () => {
      await h.prisma.shop.update({ where: { id: shopA() }, data: { upiId: 'ramesh@okbank', acceptedPaymentMethods: ['CASH', 'UPI'] } });
      await register(alice, 'install-alice-0000000001', TOKEN_ALICE);
      await register(owner, 'install-owner-00000000001', TOKEN_OWNER);
      const o = await place(alice, shopA(), 'upi');
      await settled(1);
      sender.reset();
      expect((await req(h.app, alice, 'POST', `/customer/orders/${o.id}/payment`, { upiTxnRef: 'PUSHREF00001' })).statusCode).toBe(200);
      await settled(1);
      expect(sender.calls[0]!.tokens).toEqual([TOKEN_OWNER]);
      expect(sender.calls[0]!.message).toMatchObject({ type: 'order.payment_submitted', orderId: o.id });
      expect(JSON.stringify(sender.calls)).not.toContain('PUSHREF');
    });

    it('a failing or dead token never blocks the change: the inbox row is committed and dead registrations are removed', async () => {
      await register(alice, 'install-alice-0000000001', TOKEN_ALICE);
      const o = await place(alice);
      sender.reset();
      sender.failWith.set(TOKEN_ALICE, 'messaging/registration-token-not-registered');
      const rej = await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o.id}/status`, { status: 'rejected', rejectReason: 'Busy' });
      expect(rej.statusCode).toBe(200);
      await settled(1);
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('REJECTED');
      expect((await inbox(alice)).total).toBe(1);
      await vi.waitFor(async () => expect(await h.prisma.fcmRegistration.count({ where: { userId: aliceId, revokedAt: null, enabled: true } })).toBe(0), { timeout: 3000 });
      sender.throwAll = true;
      const o2 = await place(alice);
      expect((await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o2.id}/status`, { status: 'rejected', rejectReason: 'Busy' })).statusCode).toBe(200);
      expect((await inbox(alice)).total).toBe(2);
    });

    it('removing a registration (sign-out) stops pushes, and registrations are never shared between users', async () => {
      await register(alice, 'install-alice-0000000001', TOKEN_ALICE);
      expect((await req(h.app, alice, 'DELETE', '/users/me/fcm-token', { installationId: 'install-alice-0000000001' })).statusCode).toBe(204);
      const o = await place(alice);
      sender.reset();
      await req(h.app, owner, 'PATCH', `/shops/${shopA()}/orders/${o.id}/status`, { status: 'rejected', rejectReason: 'Busy' });
      await sleep(250);
      expect(sender.calls).toHaveLength(0);
      // the same physical token re-registered by another customer moves to that customer only
      await register(alice, 'install-alice-0000000001', TOKEN_ALICE);
      await register(bob, 'install-bob-000000000001', TOKEN_ALICE);
      const rows = await h.prisma.fcmRegistration.findMany({ where: { revokedAt: null, enabled: true } });
      expect(rows.filter((r) => r.userId === aliceId)).toHaveLength(0);
      expect(rows).toHaveLength(1);
      // admins cannot register push tokens
      expect((await req(h.app, admin, 'PUT', '/users/me/fcm-token', { installationId: 'install-admin-0000000001', token: TOKEN_OWNER, platform: 'android' })).statusCode).toBe(403);
    });
  });
});
