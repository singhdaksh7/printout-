import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { login } from './api-helpers.js';
import {
  bearerAuth, cookieAuth, cookieOf, DEVICE_A, dataOf, exchange, grantAuthFrom, nextStepOf, ONBOARDING_BODY, PHONES, req, sessionAuthFrom, shopOf, startHarness, tok,
  userByEmail, userOf, type Auth, type Harness
} from './helpers/profile-harness.js';

describe('POST /shops/onboarding (restricted self-onboarding)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
  });

  const counts = async () => ({
    users: await h.prisma.user.count(),
    shops: await h.prisma.shop.count(),
    subs: await h.prisma.subscription.count(),
    identities: await h.prisma.userPhoneIdentity.count()
  });
  /** A verified phone with no account -> restricted grant (web cookie by default; mobile gives a token). */
  async function restricted(phone: string = PHONES.NEW, client: 'web' | 'mobile' = 'web', ago = 5): Promise<Auth> {
    const res = await exchange(h.app, tok(phone, ago), client);
    expect([200, 201], res.body).toContain(res.statusCode);
    return grantAuthFrom(res);
  }
  const onboard = (grant: Auth, body: unknown = ONBOARDING_BODY) => req(h.app, grant, 'POST', '/shops/onboarding', body);

  describe('feature flag', () => {
    it('is OFF by default: 403 SELF_ONBOARDING_DISABLED and nothing is created', async () => {
      const off = await startHarness({ SHOP_SELF_ONBOARDING_ENABLED: 'false' });
      try {
        const grant = grantAuthFrom(await exchange(off.app, tok(PHONES.NEW, 5)));
        const before = { users: await off.prisma.user.count(), shops: await off.prisma.shop.count() };
        const res = await req(off.app, grant, 'POST', '/shops/onboarding', ONBOARDING_BODY);
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('SELF_ONBOARDING_DISABLED');
        expect(await off.prisma.user.count()).toBe(before.users);
        expect(await off.prisma.shop.count()).toBe(before.shops);
      } finally {
        await off.close();
      }
    });

    it('config default (no env) is disabled', async () => {
      const def = await startHarness({ SHOP_SELF_ONBOARDING_ENABLED: '__unset__' });
      try {
        const res = await req(def.app, grantAuthFrom(await exchange(def.app, tok(PHONES.NEW, 5))), 'POST', '/shops/onboarding', ONBOARDING_BODY);
        expect(res.statusCode).toBe(403);
      } finally {
        await def.close();
      }
    });
  });

  describe('happy path', () => {
    it('creates user + shop + phone link in one transaction, as an ACTIVE shop with no plan and no premium', async () => {
      const before = await counts();
      const grant = await restricted();
      const res = await onboard(grant);
      expect([200, 201], res.body).toContain(res.statusCode);
      const after = await counts();
      expect(after).toEqual({ users: before.users + 1, shops: before.shops + 1, subs: before.subs, identities: before.identities + 1 });

      const user = await h.prisma.user.findUniqueOrThrow({ where: { email: ONBOARDING_BODY.email }, include: { shop: true } });
      expect(user.role).toBe('SHOP_OWNER');
      expect(user.displayName).toBe(ONBOARDING_BODY.ownerName);
      expect(user.shop).toMatchObject({ displayName: ONBOARDING_BODY.shopName, address: ONBOARDING_BODY.address, status: 'ACTIVE', acceptsOrders: true });
      expect(user.shop?.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(await h.prisma.subscription.count({ where: { shopId: user.shopId! } })).toBe(0);
      expect(await h.prisma.userPhoneIdentity.findFirst({ where: { userId: user.id, phoneE164: PHONES.NEW } })).toBeTruthy();
      // A real shop gets the same bootstrap rows an admin-created shop has.
      expect(await h.prisma.shopSettings.count({ where: { shopId: user.shopId! } })).toBe(1);
    });

    it('returns the user, the shop and a server-derived nextStep (dashboard: shop is immediately live)', async () => {
      const res = await onboard(await restricted());
      const d = dataOf(res);
      expect(d.nextStep).toBe('dashboard');
      expect(userOf(res).role).toBe('shop');
      expect(userOf(res).phoneNumber).toBe(PHONES.NEW);
      expect(userOf(res).phoneVerified).toBe(true);
      const shop = shopOf(res)!;
      expect(shop.shopName).toBe(ONBOARDING_BODY.shopName);
      expect(shop.status).toBe('standard');
      expect(shop.plan ?? null).toBeNull();
      expect(shop.registeredBy).toBe('self');
      expect(shop.showQr).toBe(true);
      expect(shop.qrCodeUrl).toMatch(/^http:\/\/localhost:5173\/p\//);
    });

    it('the public QR destination is derived from the new slug and is immediately ready on registration', async () => {
      const res = await onboard(await restricted());
      const auth = sessionAuthFrom(res);
      const slug = (await h.prisma.shop.findFirstOrThrow({ where: { displayName: ONBOARDING_BODY.shopName } })).slug;
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const qr = dataOf(await req(h.app, auth, 'GET', '/shops/me/qr'));
      expect(qr.ready).toBe(true);
      expect(qr.publicUrl).toBe(`http://localhost:5173/p/${slug}`);
      expect(qr.reason).toBeNull();
      expect(nextStepOf(await req(h.app, auth, 'GET', '/users/me'))).toBe('dashboard');
    });

    it('issues a normal session (web: cookie+csrf, mobile: bearer) so the next call is authenticated as the new owner', async () => {
      const web = await onboard(await restricted(PHONES.NEW, 'web'));
      const webAuth = sessionAuthFrom(web);
      expect(webAuth).toMatchObject({ kind: 'cookie' });
      expect((await req(h.app, webAuth, 'GET', '/shops/me')).statusCode).toBe(200);

      // The transport is chosen by the body's `client` (a bearer grant alone does not imply bearer credentials).
      const mobile = await onboard(await restricted(PHONES.NEW2, 'mobile'), { ...ONBOARDING_BODY, email: 'second@newshop.test', shopName: 'Second Prints', client: 'mobile', deviceId: DEVICE_A });
      expect([200, 201], mobile.body).toContain(mobile.statusCode);
      expect(sessionAuthFrom(mobile)).toMatchObject({ kind: 'bearer' });
      const creds = dataOf(mobile);
      expect(creds).toMatchObject({ tokenType: 'Bearer' });
      expect(creds.refreshToken).toEqual(expect.any(String));
      expect(creds.session).toBeUndefined();
      expect(cookieOf(mobile, 'printout_session')).toBeUndefined();
    });

    it('the new owner can then sign in with the phone like any linked owner (and sees only their own shop)', async () => {
      await onboard(await restricted());
      const res = await exchange(h.app, tok(PHONES.NEW, 3), 'mobile');
      expect([200, 201], res.body).toContain(res.statusCode);
      expect(shopOf(res)!.shopName).toBe(ONBOARDING_BODY.shopName);
      expect(nextStepOf(res)).toBe('dashboard');
    });

    it('the new account has no usable password: email login with a guessed password fails', async () => {
      await onboard(await restricted());
      const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: ONBOARDING_BODY.email, password: 'password1234567' } });
      expect(res.statusCode).toBe(401);
    });

    it('audits the creation without tokens, phone numbers or secrets', async () => {
      const grant = await restricted();
      await onboard(grant);
      const rows = await h.prisma.auditLog.findMany();
      expect(rows.some((r) => r.action === 'shop.onboarding.created')).toBe(true);
      const blob = JSON.stringify(rows);
      expect(blob).not.toContain(PHONES.NEW);
      expect(blob).not.toContain(`uid-${PHONES.NEW}`);
      if (grant?.kind === 'grant-cookie') expect(blob).not.toContain(grant.cookie.split('=')[1]);
    });
  });

  describe('validation', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing owner name', { ...ONBOARDING_BODY, ownerName: '' }],
      ['bad email', { ...ONBOARDING_BODY, email: 'not-an-email' }],
      ['missing shop name', { ...ONBOARDING_BODY, shopName: '  ' }],
      ['too-short address', { ...ONBOARDING_BODY, address: 'x' }],
      ['pincode too short', { ...ONBOARDING_BODY, pincode: '7000' }],
      ['pincode with letters', { ...ONBOARDING_BODY, pincode: '70A016' }],
      ['pincode starting with 0', { ...ONBOARDING_BODY, pincode: '012345' }],
      ['over-long shop name', { ...ONBOARDING_BODY, shopName: 'S'.repeat(300) }]
    ];
    it.each(cases)('rejects %s with 400 and creates nothing', async (_n, body) => {
      const grant = await restricted();
      const before = await counts();
      const res = await onboard(grant, body);
      expect(res.statusCode, res.body).toBe(400);
      expect(await counts()).toEqual(before);
    });

    it('the phone number comes from the verified identity: a body phoneNumber is rejected or ignored, never used', async () => {
      const grant = await restricted();
      const res = await onboard(grant, { ...ONBOARDING_BODY, phoneNumber: '+919000000000' });
      if ([200, 201].includes(res.statusCode)) {
        const identity = await h.prisma.userPhoneIdentity.findFirstOrThrow({ where: { user: { email: ONBOARDING_BODY.email } } });
        expect(identity.phoneE164).toBe(PHONES.NEW);
        expect(await h.prisma.userPhoneIdentity.count({ where: { phoneE164: '+919000000000' } })).toBe(0);
      } else expect(res.statusCode).toBe(400);
    });

    it('the email is unique: an existing account email -> 409 EMAIL_UNAVAILABLE, nothing created', async () => {
      const grant = await restricted();
      const before = await counts();
      const res = await onboard(grant, { ...ONBOARDING_BODY, email: h.world.a.ownerEmail });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_UNAVAILABLE');
      expect(await counts()).toEqual(before);
      // upper-case variants of an existing email are the same email
      const res2 = await onboard(grant, { ...ONBOARDING_BODY, email: h.world.a.ownerEmail.toUpperCase() });
      expect(res2.statusCode).toBe(409);
    });
  });

  describe('privilege escalation attempts', () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['role admin', { role: 'PLATFORM_ADMIN' }],
      ['role lower-case admin', { role: 'admin' }],
      ['plan premium', { plan: 'premium' }],
      ['planId', { planId: 'anything' }],
      ['shop status ACTIVE', { status: 'ACTIVE' }],
      ['shop status premium', { status: 'premium' }],
      ['isVerified', { isVerified: true }],
      ['phoneVerified', { phoneVerified: true }],
      ['registeredBy admin', { registeredBy: 'admin' }],
      ['referral code', { referral: 'FREE-YEAR' }],
      ['subscription dates', { subscription: { status: 'ACTIVE', renewsAt: '2030-01-01' } }],
      ['price', { pricePaise: 0 }],
      ['shopId of another shop', { shopId: 'x' }],
      ['acceptsOrders', { acceptsOrders: true }],
      ['showQr', { showQr: true }],
      ['slug', { slug: 'sharma-print' }]
    ];
    it.each(attempts)('%s is rejected or ignored; server values win', async (_n, extra) => {
      const grant = await restricted();
      const res = await onboard(grant, { ...ONBOARDING_BODY, ...extra });
      if ([200, 201].includes(res.statusCode)) {
        const user = await h.prisma.user.findUniqueOrThrow({ where: { email: ONBOARDING_BODY.email }, include: { shop: true } });
        expect(user.role).toBe('SHOP_OWNER');
        expect(user.shop?.status).toBe('ACTIVE');
        expect(user.shop?.acceptsOrders).toBe(true);
        expect(user.shop?.slug).not.toBe('sharma-print');
        expect(await h.prisma.subscription.count({ where: { shopId: user.shopId! } })).toBe(0);
        expect(shopOf(res)!.registeredBy).toBe('self');
      } else {
        expect(res.statusCode).toBe(400);
        expect(await h.prisma.user.count({ where: { email: ONBOARDING_BODY.email } })).toBe(0);
      }
      // In every case no existing shop was touched.
      const a = await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.a.shopId } });
      expect(a.displayName).toBe('Sharma Print');
    });

    it('cannot onboard into an existing shop or take over an existing owner', async () => {
      const grant = await restricted();
      const res = await onboard(grant, { ...ONBOARDING_BODY, shopName: 'Sharma Print' });
      expect([200, 201, 400, 409]).toContain(res.statusCode);
      expect(await h.prisma.user.count({ where: { shopId: h.world.a.shopId } })).toBe(1);
      const a = await userByEmail(h.prisma, h.world.a.ownerEmail);
      expect(a.shopId).toBe(h.world.a.shopId);
    });

    it('two shops with the same name get different slugs (never overwrites an existing slug)', async () => {
      const first = await onboard(await restricted(PHONES.NEW), { ...ONBOARDING_BODY, shopName: 'Sharma Print', email: 'one@newshop.test' });
      const second = await onboard(await restricted(PHONES.NEW2), { ...ONBOARDING_BODY, shopName: 'Sharma Print', email: 'two@newshop.test' });
      expect([200, 201], first.body).toContain(first.statusCode);
      expect([200, 201], second.body).toContain(second.statusCode);
      const slugs = (await h.prisma.shop.findMany({ where: { displayName: 'Sharma Print' } })).map((s) => s.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect(slugs).toContain('sharma-print');
    });
  });

  describe('restricted grant permissions', () => {
    it('/users/me works for the grant and shows the restricted identity', async () => {
      const grant = await restricted();
      const res = await req(h.app, grant, 'GET', '/users/me');
      expect([200, 201], res.body).toContain(res.statusCode);
      expect(nextStepOf(res)).toBe('create_shop');
      expect(userOf(res).role ?? null).toBeNull();
      expect(userOf(res).phoneNumber).toBe(PHONES.NEW);
      expect(userOf(res).phoneVerified).toBe(true);
    });

    it('everything else is refused: shop data, orders, settings, QR, devices, notifications, FCM, admin, logout, PATCH', async () => {
      const grant = await restricted();
      const forbidden: Array<['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string, unknown?]> = [
        ['GET', '/shops/me'], ['GET', '/shops/me/qr'], ['PATCH', '/shops/me', { address: '1 Some Road, Pune' }], ['PATCH', '/users/me', { name: 'x' }],
        ['GET', '/shop/orders'], ['GET', '/shop/settings'], ['GET', '/shop/qr'], ['GET', '/shop/devices'], ['GET', '/shop/notifications'],
        ['PUT', '/users/me/fcm-token', { token: 'a'.repeat(40), platform: 'android' }], ['GET', '/auth/session'], ['GET', '/admin/shops'],
        ['POST', '/shop/account/phone', { idToken: tok(PHONES.NEW), currentPassword: 'x' }]
      ];
      for (const [m, url, body] of forbidden) {
        const res = await req(h.app, grant, m, url, body);
        expect([401, 403, 404], `${m} ${url} -> ${res.statusCode}`).toContain(res.statusCode);
      }
    });

    it('a session token is not an onboarding grant and a grant is not a session', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await h.prisma.userPhoneIdentity.create({ data: { userId: owner.id, firebaseUid: `uid-${PHONES.A}`, phoneE164: PHONES.A, linkedAt: new Date(), lastSignInAt: new Date() } });
      const sess = sessionAuthFrom(await exchange(h.app, tok(PHONES.A, 5), 'mobile'));
      const before = await counts();
      const res = await onboard(sess, { ...ONBOARDING_BODY, email: 'owner-session@newshop.test' });
      expect([401, 403, 409]).toContain(res.statusCode);
      expect(await counts()).toEqual(before);
    });

    it('onboarding without any credential or with a junk grant is 401', async () => {
      expect((await onboard(null)).statusCode).toBe(401);
      expect((await onboard(bearerAuth('g'.repeat(43)))).statusCode).toBe(401);
      expect((await onboard({ kind: 'grant-cookie', cookie: 'printout_onboarding=junk' })).statusCode).toBe(401);
    });

    it('an expired grant is refused', async () => {
      const grant = await restricted();
      const expired = await h.prisma.phoneOnboardingGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
      expect(expired.count).toBeGreaterThan(0);
      const res = await onboard(grant);
      expect(res.statusCode, res.body).toBe(401);
    });

    it('a grant for phone X cannot create an account for phone Y: the phone always comes from the grant', async () => {
      const grantNew = await restricted(PHONES.NEW);
      const res = await onboard(grantNew);
      expect([200, 201]).toContain(res.statusCode);
      const identity = await h.prisma.userPhoneIdentity.findFirstOrThrow({ where: { user: { email: ONBOARDING_BODY.email } } });
      expect(identity.phoneE164).toBe(PHONES.NEW);
    });

    it('if the phone gets linked to someone else after the grant was issued, onboarding does not create a second owner for it', async () => {
      const grant = await restricted(PHONES.NEW);
      const owner = await login(h.app, h.world.a.ownerEmail);
      const link = await req(h.app, cookieAuth(owner.cookie, owner.csrf), 'POST', '/shop/account/phone', { idToken: tok(PHONES.NEW, 20), currentPassword: 'correct-horse-battery-staple' });
      expect([200, 201], link.body).toContain(link.statusCode);
      const before = await counts();
      const res = await onboard(grant);
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(await counts()).toEqual(before);
    });
  });

  describe('idempotency and concurrency', () => {
    it('repeating the same registration returns the same shop and never creates a second one', async () => {
      const grant = await restricted();
      const first = await onboard(grant);
      expect([200, 201], first.body).toContain(first.statusCode);
      const after1 = await counts();
      const second = await onboard(grant);
      if ([200, 201].includes(second.statusCode)) {
        expect(shopOf(second)!.shopName).toBe(ONBOARDING_BODY.shopName);
        expect(dataOf(second).nextStep).toBe(dataOf(first).nextStep);
      } else {
        // The grant is single-use once it has produced a session: the retry must be a clean 4xx, not a duplicate.
        expect([401, 403, 409]).toContain(second.statusCode);
      }
      expect(await counts()).toEqual(after1);
      // A fresh OTP sign-in resolves to the same single shop either way.
      const again = await exchange(h.app, tok(PHONES.NEW, 2), 'mobile');
      expect(shopOf(again)!.shopName).toBe(ONBOARDING_BODY.shopName);
      expect(await counts()).toEqual(after1);
    });

    it('a repeat with DIFFERENT details does not create or modify a second shop', async () => {
      const grant = await restricted();
      await onboard(grant);
      const before = await counts();
      await onboard(grant, { ...ONBOARDING_BODY, email: 'different@newshop.test', shopName: 'Different Name' });
      expect(await counts()).toEqual(before);
      expect(await h.prisma.shop.count({ where: { displayName: 'Different Name' } })).toBe(0);
    });

    it('N concurrent identical submissions create exactly one user, one shop and one identity', async () => {
      const grant = await restricted();
      const before = await counts();
      const results = await Promise.all(Array.from({ length: 6 }, () => onboard(grant)));
      for (const r of results) expect([200, 201, 401, 409], r.body).toContain(r.statusCode);
      expect(results.some((r) => [200, 201].includes(r.statusCode))).toBe(true);
      const after = await counts();
      expect(after).toEqual({ users: before.users + 1, shops: before.shops + 1, subs: before.subs, identities: before.identities + 1 });
    });

    it('concurrent submissions with different emails on one grant still create exactly one account', async () => {
      const grant = await restricted();
      const before = await counts();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_v, i) => onboard(grant, { ...ONBOARDING_BODY, email: `race${i}@newshop.test`, shopName: `Race Shop ${i}` }))
      );
      for (const r of results) expect([200, 201, 401, 409], r.body).toContain(r.statusCode);
      const after = await counts();
      expect(after.shops).toBe(before.shops + 1);
      expect(after.users).toBe(before.users + 1);
      expect(after.identities).toBe(before.identities + 1);
    });

    it('concurrent submissions with the same email from two different phones create one account, the loser gets 409', async () => {
      const g1 = await restricted(PHONES.NEW);
      const g2 = await restricted(PHONES.NEW2);
      const before = await counts();
      const [r1, r2] = await Promise.all([onboard(g1), onboard(g2, { ...ONBOARDING_BODY, shopName: 'Other Shop' })]);
      const codes = [r1.statusCode, r2.statusCode].map((c) => (c === 201 ? 200 : c)).sort();
      expect(codes).toEqual([200, 409]);
      expect((await counts()).users).toBe(before.users + 1);
    });
  });

  describe('compatibility', () => {
    it('onboarding does not disturb existing owners, other tenants or customer tracking', async () => {
      const aBefore = await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.a.shopId } });
      await onboard(await restricted());
      const aAfter = await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.a.shopId } });
      expect(aAfter.updatedAt.getTime()).toBe(aBefore.updatedAt.getTime());
      const s = await login(h.app, h.world.a.ownerEmail);
      expect((await req(h.app, cookieAuth(s.cookie, s.csrf), 'GET', '/shop/orders')).statusCode).toBe(200);
      // The anonymous customer pages remain public and a PILOT shop is not orderable.
      const pub = await h.app.inject({ method: 'GET', url: '/api/v1/public/shops/sharma-print' });
      expect([200, 201]).toContain(pub.statusCode);
    });

    it('a self-onboarded shop is immediately active and accepts orders on its public upload page', async () => {
      await onboard(await restricted());
      const slug = (await h.prisma.shop.findFirstOrThrow({ where: { displayName: ONBOARDING_BODY.shopName } })).slug;
      const pub = await h.app.inject({ method: 'GET', url: `/api/v1/public/shops/${slug}` });
      expect(pub.statusCode).toBe(200);
      const body = pub.json().data;
      expect(body.status).toBe('ACTIVE');
      expect(body.acceptsOrders).toBe(true);
    });
  });
});
