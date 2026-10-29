import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listOwnedShops, requireOwnedShop } from '../src/domain/shop-access.js';
import { bearerAuth, cookieAuth, DEVICE_A, gtok, makeShopReady, PHONES, req, startHarness, tok, type Harness } from './helpers/profile-harness.js';
import { login } from './api-helpers.js';

/**
 * Schema-v2 phase 1: customer role, role grants, nullable customer email, customer sign-in (audience), customer profile and
 * GET /shops/mine. Disposable database only (TEST_DATABASE_URL). Existing owner/admin auth suites remain the regression net.
 */
describe('schema-v2 phase 1: identity and multi-shop', () => {
  let h: Harness;
  let age = 280;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: 'true' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    age = 280;
    await makeShopReady(h.prisma, h.world.a.shopId);
    await makeShopReady(h.prisma, h.world.b.shopId);
  });

  const asAuth = async (email: string) => {
    const session = await login(h.app, email);
    return cookieAuth(session.cookie, session.csrf);
  };
  const next = () => age--;
  const gt = (email: string, uid?: string) => gtok(email, { ago: next(), ...(uid ? { uid } : {}) });
  const authCall = (body: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/api/v1/auth', payload: body });
  const googleAs = (idToken: string, audience?: 'shop' | 'customer', installationId = DEVICE_A) =>
    authCall({ loginMethod: 'google', firebaseIdToken: idToken, installationId, platform: 'android', ...(audience ? { audience } : {}) });
  const otpAs = (phone: string, audience?: 'shop' | 'customer') =>
    authCall({ loginMethod: 'otp', firebaseIdToken: tok(phone, next()), installationId: DEVICE_A, platform: 'android', ...(audience ? { audience } : {}) });
  const data = (r: LightMyRequestResponse) => r.json().data as Record<string, any>;
  const onboardCustomer = (grantToken: string, body: Record<string, unknown> = { name: 'Riya Sen', client: 'mobile', deviceId: DEVICE_A }) =>
    req(h.app, bearerAuth(grantToken), 'POST', '/customers/onboarding', body);

  /** Google sign-up as a customer; returns the full-session access token. */
  async function newGoogleCustomer(email = 'riya@cust.test', uid?: string) {
    const restricted = await googleAs(gt(email, uid), 'customer');
    expect(restricted.statusCode, restricted.body).toBe(200);
    expect(data(restricted)).toMatchObject({ nextStep: 'create_customer', shops: [] });
    const created = await onboardCustomer(data(restricted).accessToken);
    expect(created.statusCode, created.body).toBe(201);
    return { accessToken: data(created).accessToken as string, refreshToken: data(created).refreshToken as string, body: data(created) };
  }

  it('accepts the PDF Firebase login shape at /auth/login without weakening legacy login', async () => {
    await newGoogleCustomer('pdf-login@cust.test', 'pdf-login-uid');
    const pdf = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        idToken: gt('pdf-login@cust.test', 'pdf-login-uid'),
        fcmToken: { token: 'pdf-fcm-token-01234567890123456789', platform: 'android' },
        referralCode: 'WELCOME'
      }
    });
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.json().data).toMatchObject({
      isNewUser: false,
      user: { id: expect.any(String), firebaseUid: 'pdf-login-uid', roles: ['customer'], isActive: true },
      tokenType: 'Bearer',
      compatibility: { contract: 'pdf-v1', firebaseIdTokenAcceptedOnlyForExchange: true }
    });
    expect(pdf.json().data.accessToken).toEqual(expect.any(String));

    const invalid = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { idToken: 'not-a-valid-firebase-token', fcmToken: { token: 'pdf-fcm-token-01234567890123456789', platform: 'android' } } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe('GOOGLE_TOKEN_INVALID');
  });

  describe('database invariants (migration 20261028100100)', () => {
    const mk = (over: Record<string, unknown>) => h.prisma.user.create({ data: { displayName: 'x', passwordHash: 'h', role: 'CUSTOMER', ...over } as never });
    it('allows many customers without an email (unique ignores NULL)', async () => {
      await mk({});
      await mk({});
      expect(await h.prisma.user.count({ where: { role: 'CUSTOMER', email: null } })).toBe(2);
    });
    it('refuses an owner or admin without an email', async () => {
      await expect(mk({ role: 'SHOP_OWNER' })).rejects.toThrow();
      await expect(mk({ role: 'PLATFORM_ADMIN' })).rejects.toThrow();
    });
    it('refuses a customer that belongs to a shop', async () => {
      await expect(mk({ shopId: h.world.a.shopId })).rejects.toThrow();
    });
    it('refuses out-of-range or unpaired coordinates', async () => {
      await expect(mk({ latitude: 91, longitude: 10 })).rejects.toThrow();
      await expect(mk({ latitude: 10, longitude: 181 })).rejects.toThrow();
      await expect(mk({ latitude: 10 })).rejects.toThrow();
    });
    it('keeps one grant per (user, role)', async () => {
      const u = await mk({});
      await h.prisma.userRoleGrant.create({ data: { userId: u.id, role: 'CUSTOMER' } });
      await expect(h.prisma.userRoleGrant.create({ data: { userId: u.id, role: 'CUSTOMER' } })).rejects.toThrow();
    });
  });

  describe('customer sign-up and sign-in', () => {
    it('Google: restricted pair, then onboarding creates exactly one customer with a role grant and identity', async () => {
      const before = { shops: await h.prisma.shop.count(), users: await h.prisma.user.count() };
      const c = await newGoogleCustomer();
      expect(c.body).toMatchObject({ nextStep: 'customer_home', shops: [], shop: null, isShopRegisteredAtLeastOne: false });
      expect(c.body.user).toMatchObject({ role: 'customer', email: 'riya@cust.test', name: 'Riya Sen' });
      const user = await h.prisma.user.findFirstOrThrow({ where: { role: 'CUSTOMER' }, include: { roleGrants: true, googleIdentity: true } });
      expect(user).toMatchObject({ shopId: null, isActive: true, passwordSet: false });
      expect(user.roleGrants.map((g) => g.role)).toEqual(['CUSTOMER']);
      expect(user.googleIdentity).not.toBeNull();
      expect(await h.prisma.shop.count()).toBe(before.shops);
      expect(await h.prisma.user.count()).toBe(before.users + 1);
      expect(await h.prisma.auditLog.count({ where: { action: 'customer.onboarding.created', actorType: 'CUSTOMER' } })).toBe(1);
    });

    it('phone OTP customer is created with no email', async () => {
      const restricted = await otpAs(PHONES.NEW, 'customer');
      expect(data(restricted).nextStep).toBe('create_customer');
      const created = await onboardCustomer(data(restricted).accessToken);
      expect(created.statusCode, created.body).toBe(201);
      expect(data(created).user).toMatchObject({ role: 'customer', email: null, phoneNumber: PHONES.NEW });
    });

    it('is OFF unless CUSTOMER_SIGNUP_ENABLED: 403 CUSTOMER_SIGNUP_DISABLED and nothing is created', async () => {
      const off = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: '__unset__' });
      try {
        const r = await off.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'google', firebaseIdToken: gtok('off@cust.test', { ago: 60 }), installationId: DEVICE_A, platform: 'android', audience: 'customer' } });
        const res = await req(off.app, bearerAuth(data(r).accessToken), 'POST', '/customers/onboarding', { name: 'X', client: 'mobile', deviceId: DEVICE_A });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('CUSTOMER_SIGNUP_DISABLED');
        expect(await off.prisma.user.count({ where: { role: 'CUSTOMER' } })).toBe(0);
      } finally {
        await off.close();
      }
    });

    it('signs in again with the same identity (audience customer) and refresh rotates', async () => {
      await newGoogleCustomer('again@cust.test', 'guid-again');
      const second = await googleAs(gt('again@cust.test', 'guid-again'), 'customer', 'device-second-000000001');
      expect(second.statusCode, second.body).toBe(200);
      expect(data(second)).toMatchObject({ nextStep: 'customer_home', user: { role: 'customer' } });
      const rotated = await h.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: data(second).refreshToken, deviceId: 'device-second-000000001' } });
      expect(rotated.statusCode, rotated.body).toBe(200);
      expect(data(rotated).user.role).toBe('customer');
      expect(data(rotated).refreshToken).not.toBe(data(second).refreshToken);
    });

    it('a second onboarding for an already-registered identity is 409 ALREADY_ONBOARDED, not a session', async () => {
      await newGoogleCustomer('dup@cust.test', 'guid-dup');
      const restricted = await googleAs(gt('dup@cust.test', 'guid-dup'), 'customer');
      // already linked: the sign-in itself succeeds as a customer; there is no restricted grant to onboard with
      expect(data(restricted).nextStep).toBe('customer_home');
      const again = await onboardCustomer(data(restricted).accessToken);
      expect([401, 409]).toContain(again.statusCode);
    });

    it('rejects an unknown audience, a customer audience with email+password, and unknown onboarding keys', async () => {
      expect((await authCall({ loginMethod: 'google', firebaseIdToken: gt('a@b.test'), installationId: DEVICE_A, platform: 'android', audience: 'admin' })).statusCode).toBe(400);
      expect((await authCall({ loginMethod: 'email', email: 'a@b.test', password: 'x', installationId: DEVICE_A, platform: 'android', audience: 'customer' })).statusCode).toBe(400);
      const restricted = await googleAs(gt('keys@cust.test'), 'customer');
      const res = await onboardCustomer(data(restricted).accessToken, { name: 'N', client: 'mobile', deviceId: DEVICE_A, role: 'PLATFORM_ADMIN', shopId: h.world.a.shopId });
      expect(res.statusCode).toBe(400);
      expect(await h.prisma.user.count({ where: { email: 'keys@cust.test' } })).toBe(0);
    });
  });

  describe('no linking by email or phone (AD-6)', () => {
    it('a Google identity whose email equals an owner email becomes a separate customer with NO email and never signs in as the owner', async () => {
      const ownerEmail = h.world.a.ownerEmail;
      const c = await newGoogleCustomer(ownerEmail, 'guid-owner-lookalike');
      expect(c.body.user.role).toBe('customer');
      expect(c.body.user.email).toBeNull();
      const customer = await h.prisma.user.findFirstOrThrow({ where: { role: 'CUSTOMER' } });
      expect(customer.email).toBeNull();
      const owner = await h.prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } });
      expect(owner.role).toBe('SHOP_OWNER');
      expect(owner.shopId).toBe(h.world.a.shopId);
      const googleOfOwner = await h.prisma.userGoogleIdentity.findFirst({ where: { userId: owner.id } });
      expect(googleOfOwner).toBeNull();
    });

    it('a customer identity cannot sign in to the owner app (default audience) and an owner identity cannot sign in as a customer', async () => {
      await newGoogleCustomer('cust-only@cust.test', 'guid-cust-only');
      const asShop = await googleAs(gt('cust-only@cust.test', 'guid-cust-only'));
      expect(asShop.statusCode).toBe(403);
      expect(asShop.json().error.code).toBe('FORBIDDEN');

      const owner = await h.prisma.user.findUniqueOrThrow({ where: { email: h.world.a.ownerEmail } });
      await h.prisma.userGoogleIdentity.create({ data: { userId: owner.id, firebaseUid: 'guid-real-owner', email: h.world.a.ownerEmail } });
      const asCustomer = await googleAs(gt(h.world.a.ownerEmail, 'guid-real-owner'), 'customer');
      expect(asCustomer.statusCode).toBe(403);
      const asOwner = await googleAs(gt(h.world.a.ownerEmail, 'guid-real-owner'));
      expect(asOwner.statusCode, asOwner.body).toBe(200);
      expect(data(asOwner).user.role).toBe('shop');
    });
  });

  describe('role isolation', () => {
    it('a customer token is refused by owner, admin and multi-shop routes', async () => {
      const c = await newGoogleCustomer();
      const auth = bearerAuth(c.accessToken);
      for (const url of ['/shop/orders', '/shop/settings', '/shop/pricing-rules', '/shops/mine', '/admin/dashboard', '/admin/shops']) {
        const res = await req(h.app, auth, 'GET', url);
        expect(res.statusCode, url).toBe(403);
      }
      expect((await req(h.app, auth, 'GET', '/customers/me')).statusCode).toBe(200);
    });

    it('owner and admin sessions are refused by customer routes', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      expect((await req(h.app, owner, 'GET', '/customers/me')).statusCode).toBe(403);
      const admin = await asAuth(h.world.adminEmail);
      expect((await req(h.app, admin, 'GET', '/customers/me')).statusCode).toBe(403);
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/customers/me' })).statusCode).toBe(401);
    });

    it('a blocked customer (isActive=false) is refused with ACCOUNT_BLOCKED on use, sign-in and refresh', async () => {
      const c = await newGoogleCustomer('blocked@cust.test', 'guid-blocked');
      await h.prisma.user.updateMany({ where: { role: 'CUSTOMER' }, data: { isActive: false } });
      const use = await req(h.app, bearerAuth(c.accessToken), 'GET', '/customers/me');
      expect(use.statusCode).toBe(403);
      expect(use.json().error.code).toBe('ACCOUNT_BLOCKED');
      const signIn = await googleAs(gt('blocked@cust.test', 'guid-blocked'), 'customer');
      expect(signIn.statusCode).toBe(403);
      expect(signIn.json().error.code).toBe('ACCOUNT_BLOCKED');
      const ref = await h.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: c.refreshToken, deviceId: DEVICE_A } });
      expect(ref.statusCode).toBe(403);
    });
  });

  describe('customer profile', () => {
    it('updates name, address and a coordinate pair; audits the field names only', async () => {
      const c = await newGoogleCustomer();
      const auth = bearerAuth(c.accessToken);
      const res = await req(h.app, auth, 'PATCH', '/customers/me', { name: 'Riya S', addressLine1: '12 Lake Road', city: 'Kolkata', state: 'WB', pincode: '700029', latitude: 22.5, longitude: 88.36 });
      expect(res.statusCode, res.body).toBe(200);
      expect(data(res).customer).toMatchObject({ addressLine1: '12 Lake Road', city: 'Kolkata', pincode: '700029', latitude: 22.5, longitude: 88.36 });
      expect(data(res).user.name).toBe('Riya S');
      const log = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'customer.profile.updated' } });
      expect(JSON.stringify(log.metadata)).not.toContain('Lake Road');
    });

    it('validates input and ignores nothing silently', async () => {
      const auth = bearerAuth((await newGoogleCustomer()).accessToken);
      for (const body of [{}, { latitude: 10 }, { latitude: 95, longitude: 10 }, { pincode: '12' }, { role: 'SHOP_OWNER' }, { isActive: false }, { email: 'x@y.test' }, { shopId: h.world.a.shopId }]) {
        const res = await req(h.app, auth, 'PATCH', '/customers/me', body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
      const me = await h.prisma.user.findFirstOrThrow({ where: { role: 'CUSTOMER' } });
      expect(me.role).toBe('CUSTOMER');
      expect(me.isActive).toBe(true);
    });
  });

  describe('GET /shops/mine and shop-scoped authorization', () => {
    it('returns exactly the owner\'s own shop (default) and never another tenant\'s', async () => {
      const a = await asAuth(h.world.a.ownerEmail);
      const res = await req(h.app, a, 'GET', '/shops/mine');
      expect(res.statusCode, res.body).toBe(200);
      const d = data(res);
      expect(d.items.map((s: any) => s.id)).toEqual([h.world.a.shopId]);
      expect(d).toMatchObject({ total: 1, defaultShopId: h.world.a.shopId });
      expect(d.items[0]).toMatchObject({ isDefault: true, isActive: true });
      const b = await asAuth(h.world.b.ownerEmail);
      expect(data(await req(h.app, b, 'GET', '/shops/mine')).items.map((s: any) => s.id)).toEqual([h.world.b.shopId]);
    });

    it('lists additional OWNER memberships, but not STAFF memberships or other tenants', async () => {
      const owner = await h.prisma.user.findUniqueOrThrow({ where: { email: h.world.a.ownerEmail } });
      const extra = await h.prisma.shop.create({ data: { slug: 'second-shop', displayName: 'Second Shop', settings: { create: {} } } });
      await h.prisma.membership.create({ data: { shopId: extra.id, userId: owner.id, role: 'OWNER' } });
      // B is shared with owner A only as STAFF: not an owned shop.
      await h.prisma.membership.create({ data: { shopId: h.world.b.shopId, userId: owner.id, role: 'STAFF' } });
      const a = await asAuth(h.world.a.ownerEmail);
      const d = data(await req(h.app, a, 'GET', '/shops/mine'));
      expect(d.items.map((s: any) => s.id).sort()).toEqual([h.world.a.shopId, extra.id].sort());
      expect(d.items.find((s: any) => s.id === extra.id).isDefault).toBe(false);
      expect(d.defaultShopId).toBe(h.world.a.shopId);
      const b = await asAuth(h.world.b.ownerEmail);
      expect(data(await req(h.app, b, 'GET', '/shops/mine')).items.map((s: any) => s.id)).toEqual([h.world.b.shopId]);
    });

    it('requireOwnedShop answers 404 for a shop the caller does not own (no cross-tenant probing)', async () => {
      const owner = await h.prisma.user.findUniqueOrThrow({ where: { email: h.world.a.ownerEmail } });
      await expect(requireOwnedShop(h.prisma, owner.id, h.world.a.shopId)).resolves.toMatchObject({ id: h.world.a.shopId });
      await expect(requireOwnedShop(h.prisma, owner.id, h.world.b.shopId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(requireOwnedShop(h.prisma, owner.id, 'does-not-exist')).rejects.toMatchObject({ statusCode: 404 });
      const admin = await h.prisma.user.findUniqueOrThrow({ where: { email: h.world.adminEmail } });
      expect(await listOwnedShops(h.prisma, admin.id)).toEqual([]);
    });

    it('is owner-only and requires authentication', async () => {
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/shops/mine' })).statusCode).toBe(401);
      const admin = await asAuth(h.world.adminEmail);
      expect((await req(h.app, admin, 'GET', '/shops/mine')).statusCode).toBe(403);
    });

    it('new shops created by self-onboarding and by admin get an OWNER membership and role grant', async () => {
      const admin = await asAuth(h.world.adminEmail);
      const res = await req(h.app, admin, 'POST', '/admin/shops', { slug: 'admin-made', displayName: 'Admin Made', owner: { email: 'newowner@x.test', displayName: 'New Owner', password: 'S0me-long-Password!42' } });
      expect(res.statusCode, res.body).toBe(201);
      const owner = await h.prisma.user.findUniqueOrThrow({ where: { email: 'newowner@x.test' }, include: { memberships: true, roleGrants: true } });
      expect(owner.memberships).toMatchObject([{ role: 'OWNER', shopId: owner.shopId }]);
      expect(owner.roleGrants.map((g) => g.role)).toEqual(['SHOP_OWNER']);
    });
  });
});
