import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenHash } from '../src/auth.js';
import { PASSWORD, call } from './api-helpers.js';
import {
  bearerAuth, collectKeys, cookieOf, DEVICE_A, DEVICE_B, exchange, FORBIDDEN_KEYS, linkPhoneDirect, makeShopReady, makeShoplessOwner, ONBOARDING_BODY, PHONES,
  refresh, req, startHarness, tok, userByEmail, type Harness
} from './helpers/profile-harness.js';

/** POST /auth: the single mobile sign-in (loginMethod otp | email), flat Bearer tokens. */
const INSTALL = DEVICE_A;
const USER_KEYS = ['id', 'role', 'name', 'email', 'phoneNumber', 'loginMethods', 'emailVerified', 'phoneVerified', 'createdAt', 'updatedAt', 'lastLoginAt'];
const SHOP_KEYS = [
  'id', 'ownerId', 'shopName', 'phoneNumber', 'address', 'location', 'status', 'plan', 'isVerified', 'isActive', 'showQr', 'qrCodeUrl', 'rateInfo',
  'services', 'payment', 'rating', 'createdAt', 'updatedAt', 'slug', 'shopStatus', 'acceptsOrders', 'isDefault'
];
const TOP_KEYS = ['accessToken', 'refreshToken', 'tokenType', 'expiresIn', 'isShopRegisteredAtLeastOne', 'showQr', 'nextStep', 'user', 'shops'];
const FCM_1 = 'fcm-login-token-ONE-0123456789-abcdefghijklmnopqrstuvwxyz';
const FCM_2 = 'fcm-login-token-TWO-0123456789-abcdefghijklmnopqrstuvwxyz';

describe('POST /auth (mobile sign-in: otp and email)', () => {
  let h: Harness;
  let age = 280;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    age = 280;
    await makeShopReady(h.prisma, h.world.a.shopId);
    await makeShopReady(h.prisma, h.world.b.shopId);
  });

  const authCall = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth', payload: body, headers });
  const otp = (phone: string = PHONES.A, extra: Record<string, unknown> = {}, ago = age--) =>
    authCall({ loginMethod: 'otp', firebaseIdToken: tok(phone, ago), installationId: INSTALL, platform: 'android', ...extra });
  const email = (e: string, password: string = PASSWORD, extra: Record<string, unknown> = {}) =>
    authCall({ loginMethod: 'email', email: e, password, installationId: INSTALL, platform: 'android', ...extra });
  const linkA = async () => linkPhoneDirect(h.prisma, (await userByEmail(h.prisma, h.world.a.ownerEmail)).id, PHONES.A);
  const data = (r: LightMyRequestResponse) => r.json().data as Record<string, any>;
  const me = (accessToken: string) => req(h.app, bearerAuth(accessToken), 'GET', '/users/me');
  const noTokens = (r: LightMyRequestResponse) => {
    expect(r.body).not.toMatch(/"(accessToken|refreshToken)"/);
    expect(r.cookies.length).toBe(0);
  };
  const regs = () => h.prisma.fcmRegistration.findMany({ where: { enabled: true, revokedAt: null } });
  const sameError = (a: LightMyRequestResponse, b: LightMyRequestResponse) => {
    const strip = (r: LightMyRequestResponse) => {
      const e = { ...r.json().error };
      delete e.requestId;
      return e;
    };
    expect(strip(a)).toEqual(strip(b));
  };

  describe('response contract', () => {
    it('OTP sign-in of a ready shop: flat tokens, exact top-level, user and shop fields, server-computed flags', async () => {
      await linkA();
      await h.prisma.shopSettings.update({ where: { shopId: h.world.a.shopId }, data: { publicContact: '+919111122222' } });
      const res = await otp();
      expect(res.statusCode, res.body).toBe(200);
      const d = data(res);
      for (const k of TOP_KEYS) expect(Object.keys(d), `missing ${k}`).toContain(k);
      expect(d.session).toBeUndefined(); // no nested session object
      expect(d.tokenType).toBe('Bearer');
      expect(d.expiresIn).toBeLessThanOrEqual(900); // seconds left of the 15-minute access token
      expect(d.expiresIn).toBeGreaterThan(890);
      expect(d.refreshTokenExpiresIn).toBeGreaterThan(29 * 86_400);
      expect(d.accessToken).toEqual(expect.any(String));
      expect(d.refreshToken).toEqual(expect.any(String));
      expect(d.refreshToken).not.toBe(d.accessToken);
      expect(d.isShopRegisteredAtLeastOne).toBe(true);
      expect(d.showQr).toBe(true);
      expect(d.nextStep).toBe('dashboard');
      expect(cookieOf(res, 'printout_session')).toBeUndefined(); // mobile transport: Bearer only

      for (const k of USER_KEYS) expect(Object.keys(d.user), `user missing ${k}`).toContain(k);
      expect(Object.keys(d.user).sort()).toEqual([...USER_KEYS].sort());
      expect(d.user).toMatchObject({ role: 'shop', email: h.world.a.ownerEmail, phoneNumber: PHONES.A, phoneVerified: true, emailVerified: false });
      expect([...d.user.loginMethods].sort()).toEqual(['email', 'otp']);
      expect(Date.parse(d.user.createdAt)).not.toBeNaN();
      expect(Date.parse(d.user.lastLoginAt)).toBeGreaterThan(Date.now() - 60_000);

      expect(d.shops).toHaveLength(1);
      const s = d.shops[0];
      for (const k of SHOP_KEYS) expect(Object.keys(s), `shop missing ${k}`).toContain(k);
      expect(s).toMatchObject({
        ownerId: d.user.id, shopName: 'Sharma Print', slug: 'sharma-print', shopStatus: 'ACTIVE', acceptsOrders: true, isDefault: true, showQr: true,
        address: '12 MG Road, Bengaluru'
      });
      const owner = await h.prisma.user.findUniqueOrThrow({ where: { id: s.ownerId } });
      expect(owner.shopId).toBe(s.id);
      expect(s.id).not.toBe(d.user.id);
      expect(s.phoneNumber).toBe('+919111122222');
      expect(s.phoneNumber).not.toBe(d.user.phoneNumber);
      expect(s.qrCodeUrl).toBe('http://localhost:5173/p/sharma-print');
      expect(['standard', 'premium']).toContain(s.status);
      expect(s.status).toBe('standard');
      expect(s.isVerified === null || typeof s.isVerified === 'boolean').toBe(true); // null: no verification concept exists, never invented
      expect(typeof s.isActive).toBe('boolean');
      expect(s.isActive).toBe(true);
      // nothing in the application backs these today: null, never invented
      expect(s.rating).toBeNull();
      expect(s.payment).toBeNull();
      expect(s.location).toBeNull();
      expect(s.plan).toMatchObject({ name: 'Starter' });
      expect(Array.isArray(s.rateInfo)).toBe(true);
      expect(s.rateInfo).toHaveLength(4);
      expect(s.phoneNumber === null || typeof s.phoneNumber === 'string').toBe(true);
      expect(Date.parse(s.createdAt)).not.toBeNaN();
    });

    it('no secret or internal field is returned anywhere in the body', async () => {
      await linkA();
      const res = await otp(PHONES.A, { fcmToken: FCM_1 });
      const keys = collectKeys(res.json());
      for (const k of [...FORBIDDEN_KEYS, 'tokenCipher', 'installationId', 'familyId', 'kmsKeyRef']) expect(keys.has(k), k).toBe(false);
      expect(res.body).not.toContain(FCM_1);
      expect(res.body).not.toContain(`uid-${PHONES.A}`);
    });

    it('the issued access token authorises the existing routes; the refresh token renews it (deviceId = installationId)', async () => {
      await linkA();
      const d = data(await otp());
      expect((await me(d.accessToken)).statusCode).toBe(200);
      expect((await req(h.app, bearerAuth(d.accessToken), 'GET', '/shop/orders')).statusCode).toBe(200);
      expect((await me(d.refreshToken)).statusCode).toBe(401);
      const next = await refresh(h.app, d.refreshToken, INSTALL);
      expect(next.statusCode, next.body).toBe(200);
    });

    it('the shops array is a single default shop (Membership is not used to grant access)', async () => {
      await linkA();
      const shops = data(await otp()).shops;
      expect(shops).toHaveLength(1);
      expect(shops.filter((x: any) => x.isDefault)).toHaveLength(1);
    });
  });

  describe('nextStep and the computed flags', () => {
    it('no shop -> isShopRegisteredAtLeastOne false, showQr false, create_shop, shops []', async () => {
      const owner = await makeShoplessOwner(h.prisma);
      await linkPhoneDirect(h.prisma, owner.id, PHONES.NOSHOP);
      const d = data(await otp(PHONES.NOSHOP));
      expect(d).toMatchObject({ isShopRegisteredAtLeastOne: false, showQr: false, nextStep: 'create_shop', shops: [] });
      expect(d.user.role).toBe('shop');
      expect(d.accessToken).toEqual(expect.any(String));
    });

    it('incomplete profile (no address) -> complete_profile', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { address: null } });
      await linkA();
      const d = data(await otp());
      expect(d.nextStep).toBe('complete_profile');
      expect(d.isShopRegisteredAtLeastOne).toBe(true);
      expect(d.shops).toHaveLength(1);
    });

    it('PILOT shop / QR unavailable -> generate_qr, showQr false, qrCodeUrl null', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'PILOT' } });
      await linkA();
      const d = data(await otp());
      expect(d).toMatchObject({ nextStep: 'generate_qr', showQr: false, isShopRegisteredAtLeastOne: true });
      expect(d.shops[0].showQr).toBe(false);
      expect(d.shops[0].qrCodeUrl).toBeNull();
    });

    it('active and complete -> dashboard with qrCodeUrl === WEB_ORIGIN/p/<slug>', async () => {
      await linkA();
      const d = data(await otp());
      expect(d.nextStep).toBe('dashboard');
      expect(d.shops[0].qrCodeUrl).toBe(`http://localhost:5173/p/${d.shops[0].slug}`);
    });

    it('flags are never taken from the client: extra keys are rejected or ignored', async () => {
      const owner = await makeShoplessOwner(h.prisma);
      await linkPhoneDirect(h.prisma, owner.id, PHONES.NOSHOP);
      const res = await otp(PHONES.NOSHOP, { isShopRegisteredAtLeastOne: true, showQr: true, nextStep: 'dashboard', role: 'admin', shops: [{ id: h.world.b.shopId }], shopId: h.world.b.shopId });
      if (res.statusCode === 200) {
        const d = data(res);
        expect(d).toMatchObject({ isShopRegisteredAtLeastOne: false, showQr: false, nextStep: 'create_shop', shops: [] });
        expect(d.user.role).toBe('shop');
      } else {
        expect(res.statusCode).toBe(400);
        noTokens(res);
      }
    });

    it('a PILOT shop never reports showQr true even if the client insists', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'PILOT' } });
      await linkA();
      const res = await otp(PHONES.A, { showQr: true });
      if (res.statusCode === 200) expect(data(res).showQr).toBe(false);
      else expect(res.statusCode).toBe(400);
    });
  });

  describe('loginMethod otp', () => {
    it('a phoneNumber that matches the verified phone is accepted; one that does not is refused with no tokens', async () => {
      await linkA();
      const ok = await otp(PHONES.A, { phoneNumber: PHONES.A });
      expect(ok.statusCode, ok.body).toBe(200);
      const bad = await otp(PHONES.A, { phoneNumber: PHONES.B });
      expect(bad.statusCode, bad.body).toBeGreaterThanOrEqual(400);
      expect(bad.statusCode).toBeLessThan(500);
      noTokens(bad);
      expect(await h.prisma.refreshToken.count({ where: { user: { email: h.world.b.ownerEmail } } })).toBe(0);
    });

    it('the phone number alone never authorises: no token, a bad token, a token for another project all fail with no tokens issued', async () => {
      await linkA();
      const attempts: Array<Record<string, unknown>> = [
        { loginMethod: 'otp', phoneNumber: PHONES.A, installationId: INSTALL, platform: 'android' },
        { loginMethod: 'otp', phoneNumber: PHONES.A, firebaseIdToken: 'garbage-token-garbage-token', installationId: INSTALL, platform: 'android' },
        { loginMethod: 'otp', firebaseIdToken: tok(PHONES.A, 5, { projectId: 'other-project' }), installationId: INSTALL, platform: 'android' },
        { loginMethod: 'otp', firebaseIdToken: tok(PHONES.A, 3600), installationId: INSTALL, platform: 'android' },
        { loginMethod: 'otp', firebaseIdToken: tok(PHONES.A, 5, { provider: 'password' }), installationId: INSTALL, platform: 'android' }
      ];
      for (const body of attempts) {
        const res = await authCall(body);
        expect([400, 401], res.body).toContain(res.statusCode);
        noTokens(res);
      }
    });

    it('a replayed Firebase ID token is refused the second time', async () => {
      await linkA();
      const body = { loginMethod: 'otp', firebaseIdToken: tok(PHONES.A, 10), installationId: INSTALL, platform: 'android' };
      expect((await authCall(body)).statusCode).toBe(200);
      const again = await authCall(body);
      expect(again.statusCode).toBeGreaterThanOrEqual(400);
      noTokens(again);
    });

    it('a Firebase-disabled user and a recycled number (different UID) are refused', async () => {
      await linkA();
      const recycled = await authCall({ loginMethod: 'otp', firebaseIdToken: tok(PHONES.A, 6, { uid: 'uid-someone-else' }), installationId: INSTALL, platform: 'android' });
      expect(recycled.statusCode, recycled.body).toBe(403);
      noTokens(recycled);
      h.emulator.disabled.add(`uid-${PHONES.A}`);
      const disabled = await otp();
      expect([401, 403]).toContain(disabled.statusCode);
      noTokens(disabled);
    });

    it('rejects bad request shapes with 400: missing token, unknown loginMethod, missing/short installationId, bad platform', async () => {
      await linkA();
      const t = () => tok(PHONES.A, age--);
      const bad: Array<Record<string, unknown>> = [
        { loginMethod: 'otp', installationId: INSTALL, platform: 'android' },
        { loginMethod: 'sms', firebaseIdToken: t(), installationId: INSTALL, platform: 'android' },
        { firebaseIdToken: t(), installationId: INSTALL, platform: 'android' },
        { loginMethod: 'otp', firebaseIdToken: t(), platform: 'android' },
        { loginMethod: 'otp', firebaseIdToken: t(), installationId: 'x', platform: 'android' },
        { loginMethod: 'otp', firebaseIdToken: t(), installationId: INSTALL, platform: 'blackberry' },
        { loginMethod: 'otp', firebaseIdToken: t(), installationId: INSTALL },
        {}
      ];
      for (const body of bad) {
        const res = await authCall(body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
        noTokens(res);
      }
    });

    it('an admin with a forced phone identity is refused with no tokens', async () => {
      const admin = await userByEmail(h.prisma, h.world.adminEmail);
      await linkPhoneDirect(h.prisma, admin.id, PHONES.ADMIN);
      const res = await otp(PHONES.ADMIN);
      expect([401, 403], res.body).toContain(res.statusCode);
      noTokens(res);
      expect(await h.prisma.refreshToken.count({ where: { userId: admin.id } })).toBe(0);
    });
  });

  describe('restricted onboarding identity (verified phone, no account)', () => {
    it('gets an access + refresh token pair, create_shop, no shops, and can call only /users/me and onboarding', async () => {
      const res = await otp(PHONES.NEW);
      expect(res.statusCode, res.body).toBe(200);
      const d = data(res);
      expect(d).toMatchObject({ tokenType: 'Bearer', isShopRegisteredAtLeastOne: false, showQr: false, nextStep: 'create_shop', shops: [] });
      expect(d.expiresIn).toBeGreaterThan(890);
      expect(d.accessToken).toEqual(expect.any(String));
      expect(d.refreshToken).toEqual(expect.any(String));
      expect(d.user.role ?? null).toBeNull();
      expect(d.user.phoneNumber).toBe(PHONES.NEW);
      expect(d.user.phoneVerified).toBe(true);
      const who = await me(d.accessToken);
      expect(who.statusCode, who.body).toBe(200);
      for (const [m, url] of [['GET', '/shops/me'], ['GET', '/shops/me/qr'], ['GET', '/shop/orders'], ['GET', '/shop/settings'], ['PATCH', '/users/me']] as const) {
        const r = await req(h.app, bearerAuth(d.accessToken), m, url, m === 'PATCH' ? { name: 'x' } : undefined);
        expect([401, 403, 404], `${m} ${url}`).toContain(r.statusCode);
      }
      // nothing was created for a phone that has no account
      expect(await h.prisma.user.count({ where: { shop: null, role: 'SHOP_OWNER' } })).toBe(0);
    });

    it('the restricted refresh token renews a restricted pair while the identity stays unlinked', async () => {
      const d = data(await otp(PHONES.NEW));
      const next = await refresh(h.app, d.refreshToken, INSTALL);
      expect(next.statusCode, next.body).toBe(200);
      const pair = next.json().data.session ?? next.json().data;
      expect(pair.accessToken).toEqual(expect.any(String));
      expect(pair.accessToken).not.toBe(d.accessToken);
      expect((await req(h.app, bearerAuth(pair.accessToken), 'GET', '/shops/me')).statusCode).toBeGreaterThanOrEqual(401);
    });

    it('onboarding itself returns the normal pair for this installation and spends the restricted refresh token', async () => {
      const d = data(await otp(PHONES.NEW));
      const created = await req(h.app, bearerAuth(d.accessToken), 'POST', '/shops/onboarding', { ...ONBOARDING_BODY, client: 'mobile', deviceId: INSTALL });
      expect([200, 201], created.body).toContain(created.statusCode);
      const pair = data(created);
      expect(pair).toMatchObject({ tokenType: 'Bearer', nextStep: 'dashboard', isShopRegisteredAtLeastOne: true });
      expect(pair.user.role).toBe('shop');
      const shop = await req(h.app, bearerAuth(pair.accessToken), 'GET', '/shops/me');
      expect(shop.statusCode, shop.body).toBe(200);
      // the restricted refresh token is done (by design); the account's own refresh token renews
      const spent = await refresh(h.app, d.refreshToken, INSTALL);
      expect(spent.statusCode).toBe(401);
      expect((await refresh(h.app, pair.refreshToken, INSTALL)).statusCode).toBe(200);
    });

    it('refresh UPGRADES a restricted pair to a normal pair once the identity gets linked to an account some other way', async () => {
      const d = data(await otp(PHONES.NEW));
      const owner = await makeShoplessOwner(h.prisma, 'later-linked@x.test');
      await linkPhoneDirect(h.prisma, owner.id, PHONES.NEW);
      const next = await refresh(h.app, d.refreshToken, INSTALL);
      expect(next.statusCode, next.body).toBe(200);
      const upgraded = data(next);
      expect(upgraded.user.role).toBe('shop');
      expect(upgraded.user.id).toBe(owner.id);
      expect(upgraded.nextStep).toBe('create_shop');
      expect((await me(upgraded.accessToken)).statusCode).toBe(200);
      // the restricted access token never became an account token
      const stale = await me(d.accessToken);
      if (stale.statusCode === 200) expect(JSON.stringify(stale.json().data)).not.toContain(owner.id);
      else expect([401, 403]).toContain(stale.statusCode);
    });

    it('a restricted access token cannot register push tokens', async () => {
      const d = data(await otp(PHONES.NEW));
      const r = await req(h.app, bearerAuth(d.accessToken), 'PUT', '/users/me/fcm-token', { installationId: INSTALL, token: FCM_1, platform: 'android' });
      expect([401, 403]).toContain(r.statusCode);
      expect(await regs()).toHaveLength(0);
    });

    it('an fcmToken sent with a restricted sign-in is not stored (no account to bind it to)', async () => {
      const res = await otp(PHONES.NEW, { fcmToken: FCM_1 });
      expect(res.statusCode, res.body).toBe(200);
      expect(await h.prisma.fcmRegistration.count()).toBe(0);
    });
  });

  describe('loginMethod email', () => {
    it('signs in with email + password and returns the same contract', async () => {
      const res = await email(h.world.a.ownerEmail);
      expect(res.statusCode, res.body).toBe(200);
      const d = data(res);
      for (const k of TOP_KEYS) expect(Object.keys(d), `missing ${k}`).toContain(k);
      expect(d.nextStep).toBe('dashboard');
      expect(d.user.loginMethods).toContain('email');
      expect(d.user.email).toBe(h.world.a.ownerEmail);
      expect(d.shops).toHaveLength(1);
      expect((await me(d.accessToken)).statusCode).toBe(200);
      expect((await refresh(h.app, d.refreshToken, INSTALL)).statusCode).toBe(200);
    });

    it('the email is case-insensitive and trimmed', async () => {
      expect((await email(`  ${h.world.a.ownerEmail.toUpperCase()}  `)).statusCode).toBe(200);
    });

    it('an email alone never authorises (400), and unknown account / wrong password are the identical 401', async () => {
      const alone = await authCall({ loginMethod: 'email', email: h.world.a.ownerEmail, installationId: INSTALL, platform: 'android' });
      expect(alone.statusCode).toBe(400);
      noTokens(alone);
      const wrong = await email(h.world.a.ownerEmail, 'definitely-the-wrong-password');
      const unknown = await email('nobody@nowhere.test', 'definitely-the-wrong-password');
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
      sameError(wrong, unknown);
      noTokens(wrong);
    });

    it('admins are refused (403) with no tokens, even with the right password', async () => {
      const res = await email(h.world.adminEmail);
      expect(res.statusCode, res.body).toBe(403);
      noTokens(res);
      expect(await h.prisma.refreshToken.count({ where: { user: { email: h.world.adminEmail } } })).toBe(0);
    });

    it('a phone-onboarded account has no usable password: email sign-in fails with the generic 401', async () => {
      const d = data(await otp(PHONES.NEW));
      await req(h.app, bearerAuth(d.accessToken), 'POST', '/shops/onboarding', { ...ONBOARDING_BODY, client: 'mobile', deviceId: INSTALL });
      const res = await email(ONBOARDING_BODY.email, 'password1234567');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    });

    it('an owner with no shop gets create_shop and an empty shops array', async () => {
      const owner = await makeShoplessOwner(h.prisma);
      const res = await email(owner.email);
      expect(res.statusCode, res.body).toBe(200);
      expect(data(res)).toMatchObject({ nextStep: 'create_shop', isShopRegisteredAtLeastOne: false, showQr: false, shops: [] });
    });

    it('repeated failures are throttled (429) and a blocked account cannot sign in even with the right password', async () => {
      const t = await startHarness({ LOGIN_FAIL_MAX: '3' });
      try {
        const attempt = (pw: string) =>
          t.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'email', email: t.world.a.ownerEmail, password: pw, installationId: INSTALL, platform: 'android' } });
        for (let i = 0; i < 3; i++) expect((await attempt(`wrong-password-${i}`)).statusCode).toBe(401);
        const blocked = await attempt('wrong-password-again');
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json().error.code).toBe('RATE_LIMITED');
        expect((await attempt(PASSWORD)).statusCode).toBe(429);
        expect(blocked.body).not.toMatch(/"(accessToken|refreshToken)"/);
      } finally {
        await t.close();
      }
    });

    it('repeated failed OTP verifications are throttled too', async () => {
      const t = await startHarness({ LOGIN_FAIL_MAX: '3' });
      try {
        const bad = () => t.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'otp', firebaseIdToken: 'garbage-token-garbage-token', installationId: INSTALL, platform: 'android' } });
        const codes: number[] = [];
        for (let i = 0; i < 8; i++) codes.push((await bad()).statusCode);
        expect(codes).toContain(429);
        expect(codes.every((c) => [400, 401, 429].includes(c))).toBe(true);
      } finally {
        await t.close();
      }
    });
  });

  describe('blocked accounts', () => {
    it('a suspended shop: 403 ACCOUNT_BLOCKED with details.nextStep account_blocked and no tokens (otp and email)', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'SUSPENDED' } });
      await linkA();
      for (const res of [await otp(), await email(h.world.a.ownerEmail)]) {
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('ACCOUNT_BLOCKED');
        expect(res.json().error.details.nextStep).toBe('account_blocked');
        noTokens(res);
      }
      expect(await h.prisma.refreshToken.count({ where: { userId: (await userByEmail(h.prisma, h.world.a.ownerEmail)).id } })).toBe(0);
    });

    it('a blocked sign-in does not register an fcmToken', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'SUSPENDED' } });
      const res = await email(h.world.a.ownerEmail, PASSWORD, { fcmToken: FCM_1 });
      expect(res.statusCode).toBe(403);
      expect(await h.prisma.fcmRegistration.count()).toBe(0);
    });

    it('un-suspending restores sign-in', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'SUSPENDED' } });
      expect((await email(h.world.a.ownerEmail)).statusCode).toBe(403);
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'ACTIVE' } });
      expect((await email(h.world.a.ownerEmail)).statusCode).toBe(200);
    });
  });

  describe('fcmToken on login', () => {
    it('is registered only after authentication, bound to user + installationId + platform, stored encrypted, never echoed', async () => {
      const res = await email(h.world.a.ownerEmail, PASSWORD, { fcmToken: FCM_1, platform: 'ios' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain(FCM_1);
      const [row] = await regs();
      expect(row).toMatchObject({ installationId: INSTALL, platform: 'ios', shopId: h.world.a.shopId });
      expect(row!.userId).toBe((await userByEmail(h.prisma, h.world.a.ownerEmail)).id);
      expect(row!.tokenHash).toBe(tokenHash(FCM_1));
      expect(row!.tokenCipher).not.toContain(FCM_1);
    });

    it('a failed sign-in registers nothing', async () => {
      const res = await email(h.world.a.ownerEmail, 'wrong-password-123', { fcmToken: FCM_1 });
      expect(res.statusCode).toBe(401);
      expect(await h.prisma.fcmRegistration.count()).toBe(0);
    });

    it('an unusable fcmToken never fails the sign-in (the login still succeeds without a registration)', async () => {
      for (const fcmToken of ['short', 'has a space inside it 0123456789-0123456789', 'x'.repeat(5000)]) {
        const res = await email(h.world.a.ownerEmail, PASSWORD, { fcmToken });
        expect(res.statusCode, `${fcmToken.slice(0, 12)}: ${res.body}`).toBe(200);
      }
      expect(await h.prisma.fcmRegistration.count()).toBe(0);
    });

    it('ownership: a token another account held moves to the new signer-in and the old registration is revoked', async () => {
      await email(h.world.a.ownerEmail, PASSWORD, { fcmToken: FCM_1 });
      const res = await authCall({ loginMethod: 'email', email: h.world.b.ownerEmail, password: PASSWORD, installationId: DEVICE_B, platform: 'android', fcmToken: FCM_1 });
      expect(res.statusCode, res.body).toBe(200);
      const live = await regs();
      expect(live).toHaveLength(1);
      expect(live[0]!.userId).toBe((await userByEmail(h.prisma, h.world.b.ownerEmail)).id);
      expect(live[0]!.shopId).toBe(h.world.b.shopId);
    });

    it('signing in again from the same installation keeps one registration and replaces the token', async () => {
      await email(h.world.a.ownerEmail, PASSWORD, { fcmToken: FCM_1 });
      await email(h.world.a.ownerEmail, PASSWORD, { fcmToken: FCM_2 });
      const live = await regs();
      expect(live).toHaveLength(1);
      expect(live[0]!.tokenHash).toBe(tokenHash(FCM_2));
    });

    it('a sign-in without an fcmToken leaves an existing registration alone', async () => {
      await email(h.world.a.ownerEmail, PASSWORD, { fcmToken: FCM_1 });
      await email(h.world.a.ownerEmail);
      expect(await regs()).toHaveLength(1);
    });

    it('audit rows never contain the token, the password or the Firebase ID token', async () => {
      await linkA();
      const idToken = tok(PHONES.A, 7);
      await authCall({ loginMethod: 'otp', firebaseIdToken: idToken, installationId: INSTALL, platform: 'android', fcmToken: FCM_1 });
      const out = await email(h.world.a.ownerEmail, PASSWORD, { fcmToken: FCM_2 });
      const blob = JSON.stringify(await h.prisma.auditLog.findMany());
      for (const secret of [FCM_1, FCM_2, idToken, PASSWORD, data(out).accessToken, data(out).refreshToken, PHONES.A]) expect(blob.includes(secret), secret.slice(0, 10)).toBe(false);
    });
  });

  describe('sessions per installation', () => {
    it('a second sign-in from the same installation supersedes the first; another installation is untouched', async () => {
      const first = data(await email(h.world.a.ownerEmail));
      const other = data(await authCall({ loginMethod: 'email', email: h.world.a.ownerEmail, password: PASSWORD, installationId: DEVICE_B, platform: 'android' }));
      const second = data(await email(h.world.a.ownerEmail));
      expect((await me(first.accessToken)).statusCode).toBe(401);
      expect((await me(second.accessToken)).statusCode).toBe(200);
      expect((await me(other.accessToken)).statusCode).toBe(200);
    });
  });

  describe('existing web flows are unchanged', () => {
    it('POST /auth/login still returns the original payload and sets the cookie', async () => {
      const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: h.world.a.ownerEmail, password: PASSWORD } });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json().data).sort()).toEqual(['csrfToken', 'retentionMinutes', 'shop', 'user']);
      expect(cookieOf(res, 'printout_session')).toBeTruthy();
    });

    it('POST /auth/firebase/exchange (web) still works alongside it', async () => {
      await linkA();
      const res = await exchange(h.app, tok(PHONES.A, 4), 'web');
      expect(res.statusCode, res.body).toBe(200);
      expect(cookieOf(res, 'printout_session')).toBeTruthy();
    });

    it('Admin 2FA login is unchanged: an enrolled admin still gets the challenge from /auth/login and nothing from /auth', async () => {
      const s = await call(h.app, null, 'POST', '/auth/login', { email: h.world.adminEmail, password: PASSWORD });
      expect(s.statusCode).toBe(200);
      const viaMobile = await email(h.world.adminEmail);
      expect(viaMobile.statusCode).toBe(403);
      noTokens(viaMobile);
    });
  });
});
