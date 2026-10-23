import { ShopStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneVerifierUnavailableError, type PhoneTokenVerifier } from '../src/firebase/verifier.js';
import { call, login, PASSWORD } from './api-helpers.js';
import {
  bearerAuth, cookieAuth, cookieOf, dataOf, exchange, FORBIDDEN_KEYS, collectKeys, grantAuthFrom, linkPhoneDirect, makeShopReady,
  makeShoplessOwner, nextStepOf, PHONES, PROJECT, req, sessionAuthFrom, startHarness, tok, userByEmail, type Harness
} from './helpers/profile-harness.js';

const STEPS = ['dashboard', 'complete_profile', 'create_shop', 'generate_qr', 'account_blocked'];

describe('POST /auth/firebase/exchange', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
  });

  const ownerA = () => userByEmail(h.prisma, h.world.a.ownerEmail);
  const ownerB = () => userByEmail(h.prisma, h.world.b.ownerEmail);
  async function linkA() {
    await linkPhoneDirect(h.prisma, (await ownerA()).id, PHONES.A);
  }
  const issuedNoSession = (res: { cookies: Array<{ name: string }>; body: string }) => {
    expect(res.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
    expect(res.body).not.toMatch(/"(token|accessToken|refreshToken)"\s*:\s*"[A-Za-z0-9_-]{20,}"/);
  };

  describe('resolved states -> nextStep', () => {
    it('existing linked shop with address, ACTIVE status and a QR destination -> dashboard (web: cookie + csrf)', async () => {
      await makeShopReady(h.prisma, h.world.a.shopId);
      await linkA();
      const res = await exchange(h.app, tok(PHONES.A, 5), 'web');
      expect(res.statusCode, res.body).toBe(200);
      const d = dataOf(res);
      expect(d.nextStep).toBe('dashboard');
      expect(STEPS).toContain(d.nextStep);
      expect(d.user.role).toBe('shop');
      expect(d.shop).toBeTruthy();
      expect(d.csrfToken).toEqual(expect.any(String));
      expect(d.session).toMatchObject({ transport: 'cookie' });
      expect(Date.parse(d.session.expiresAt)).toBeGreaterThan(Date.now());
      expect(cookieOf(res, 'printout_session')?.httpOnly).toBe(true);
      expect(typeof d.onboardingAvailable).toBe('boolean');
      expect(typeof d.retentionMinutes).toBe('number');
    });

    it('a shop with no address -> complete_profile (but a session is issued)', async () => {
      await linkA(); // seeded shop has no address
      const res = await exchange(h.app, tok(PHONES.A, 5));
      expect(res.statusCode, res.body).toBe(200);
      expect(nextStepOf(res)).toBe('complete_profile');
      expect(cookieOf(res, 'printout_session')).toBeTruthy();
    });

    it('a user with an empty name -> complete_profile even when the shop is complete', async () => {
      await makeShopReady(h.prisma, h.world.a.shopId);
      const u = await ownerA();
      await h.prisma.user.update({ where: { id: u.id }, data: { displayName: '' } });
      await linkA();
      expect(nextStepOf(await exchange(h.app, tok(PHONES.A, 5)))).toBe('complete_profile');
    });

    it('a PILOT shop (no live QR destination) -> generate_qr', async () => {
      await makeShopReady(h.prisma, h.world.a.shopId, { status: ShopStatus.PILOT });
      await linkA();
      const res = await exchange(h.app, tok(PHONES.A, 5));
      expect(res.statusCode, res.body).toBe(200);
      expect(nextStepOf(res)).toBe('generate_qr');
    });

    it('a linked owner with no shop -> create_shop, with a session and no shop in the payload', async () => {
      const u = await makeShoplessOwner(h.prisma);
      await linkPhoneDirect(h.prisma, u.id, PHONES.NOSHOP);
      const res = await exchange(h.app, tok(PHONES.NOSHOP, 5));
      expect(res.statusCode, res.body).toBe(200);
      expect(nextStepOf(res)).toBe('create_shop');
      expect(dataOf(res).shop ?? null).toBeNull();
      expect(dataOf(res).user.role).toBe('shop');
    });

    it('a SUSPENDED shop -> account_blocked or 403 SHOP_SUSPENDED, and never a usable session', async () => {
      await makeShopReady(h.prisma, h.world.a.shopId, { status: ShopStatus.SUSPENDED });
      await linkA();
      const res = await exchange(h.app, tok(PHONES.A, 5), 'mobile');
      if (res.statusCode === 403) {
        expect(['ACCOUNT_BLOCKED', 'SHOP_SUSPENDED']).toContain(res.json().error.code);
      } else {
        expect(res.statusCode, res.body).toBe(200);
        expect(nextStepOf(res)).toBe('account_blocked');
      }
      issuedNoSession(res);
      // And a session that already existed is cut off the same way as for password sign-in.
      const s = await login(h.app, h.world.a.ownerEmail).catch(() => null);
      expect(s).toBeNull();
    });

    it('an existing session of a shop that gets suspended: /users/me reports account_blocked, every shop route is refused', async () => {
      await makeShopReady(h.prisma, h.world.a.shopId);
      const s = await login(h.app, h.world.a.ownerEmail);
      expect(nextStepOf(await call(h.app, s, 'GET', '/users/me'))).toBe('dashboard');
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: ShopStatus.SUSPENDED } });
      const me = await call(h.app, s, 'GET', '/users/me');
      if (me.statusCode === 200) expect(nextStepOf(me)).toBe('account_blocked');
      else expect(me.statusCode).toBe(403);
      for (const url of ['/shops/me', '/shops/me/qr', '/shop/orders', '/shop/settings']) {
        expect((await call(h.app, s, 'GET', url)).statusCode, url).toBe(403);
      }
    });

    it('the response never carries the Firebase UID or other internals', async () => {
      await linkA();
      const res = await exchange(h.app, tok(PHONES.A, 5), 'mobile');
      const keys = collectKeys(res.json());
      for (const k of FORBIDDEN_KEYS) expect(keys.has(k), k).toBe(false);
      expect(res.body).not.toContain(`uid-${PHONES.A}`);
      expect(dataOf(res).user.phoneNumber).toBe(PHONES.A); // the user's OWN number is a profile field; nothing else echoes it
    });
  });

  describe('unlinked verified phone -> restricted onboarding identity', () => {
    it('web: 200, no user/shop created, role null, nextStep create_shop, onboarding grant cookie, no session cookie', async () => {
      const users = await h.prisma.user.count();
      const shops = await h.prisma.shop.count();
      const res = await exchange(h.app, tok(PHONES.NEW, 5), 'web');
      expect(res.statusCode, res.body).toBe(200);
      const d = dataOf(res);
      expect(d.nextStep).toBe('create_shop');
      expect(d.user.role ?? null).toBeNull();
      expect(d.shop ?? null).toBeNull();
      expect(d.onboardingAvailable).toBe(true);
      expect(cookieOf(res, 'printout_session')).toBeUndefined();
      const grant = cookieOf(res, 'printout_onboarding');
      expect(grant?.httpOnly).toBe(true);
      expect(await h.prisma.user.count()).toBe(users);
      expect(await h.prisma.shop.count()).toBe(shops);
    });

    it('mobile: the grant is returned as a bearer-style token and no cookie is set', async () => {
      const res = await exchange(h.app, tok(PHONES.NEW, 5), 'mobile');
      expect(res.statusCode, res.body).toBe(200);
      expect(nextStepOf(res)).toBe('create_shop');
      expect(res.cookies.length).toBe(0);
      expect(grantAuthFrom(res)).toMatchObject({ kind: 'bearer' });
    });

    it('with self-onboarding switched off the identity is still restricted and says so', async () => {
      const off = await startHarness({ SHOP_SELF_ONBOARDING_ENABLED: 'false' });
      try {
        const res = await exchange(off.app, tok(PHONES.NEW, 5));
        expect(res.statusCode, res.body).toBe(200);
        expect(nextStepOf(res)).toBe('create_shop');
        expect(dataOf(res).onboardingAvailable).toBe(false);
        expect(cookieOf(res, 'printout_session')).toBeUndefined();
      } finally {
        await off.close();
      }
    });
  });

  describe('Firebase token verification', () => {
    beforeEach(linkA);
    const invalid: Array<[string, () => string | undefined]> = [
      ['garbage', () => 'not-a-jwt-at-all-just-some-text'],
      ['truncated', () => tok(PHONES.A, 5).slice(0, 40)],
      ['wrong Firebase project (aud and iss)', () => tok(PHONES.A, 5, { projectId: 'some-other-project' })],
      ['wrong audience only', () => tok(PHONES.A, 5, { aud: 'some-other-project' })],
      ['wrong issuer only', () => tok(PHONES.A, 5, { iss: 'https://securetoken.google.com/some-other-project' })],
      ['expired', () => tok(PHONES.A, 7200, { exp: Math.floor(Date.now() / 1000) - 60 })],
      ['OTP verified too long ago', () => tok(PHONES.A, 3600)],
      ['not a phone sign-in', () => tok(PHONES.A, 5, { provider: 'password' })],
      ['no phone number claim', () => tok(null, 5)]
    ];
    it.each(invalid)('refuses %s with 401 PHONE_TOKEN_INVALID and issues nothing', async (_n, make) => {
      const res = await exchange(h.app, make());
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe('PHONE_TOKEN_INVALID');
      issuedNoSession(res);
      expect(cookieOf(res, 'printout_onboarding')).toBeUndefined();
    });

    it('an empty idToken is refused (400 validation or 401) and issues nothing', async () => {
      const res = await exchange(h.app, '');
      expect([400, 401]).toContain(res.statusCode);
      issuedNoSession(res);
    });

    it('a calling code that is not allowed is refused', async () => {
      const res = await exchange(h.app, tok('+14155550123', 5));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('PHONE_TOKEN_INVALID');
    });

    it('rejects a missing, non-string or extra-field body with 400', async () => {
      for (const payload of [{}, { idToken: 123 }, { idToken: tok(PHONES.A), role: 'admin' }, { idToken: tok(PHONES.A), client: 'toaster' }]) {
        const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/firebase/exchange', payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it('ignores client-asserted role, shop id and flags: only the verified token decides', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/firebase/exchange',
        payload: { idToken: tok(PHONES.NEW, 5), role: 'admin', shopId: h.world.b.shopId, phoneVerified: true, showQr: true }
      });
      // Either rejected by the strict schema, or processed as an anonymous restricted identity: never B's shop, never admin.
      if (res.statusCode === 200) {
        expect(dataOf(res).shop ?? null).toBeNull();
        expect(dataOf(res).user.role ?? null).toBeNull();
      } else expect(res.statusCode).toBe(400);
    });

    it('a Firebase-disabled user is refused', async () => {
      h.emulator.disabled.add(`uid-${PHONES.A}`);
      const res = await exchange(h.app, tok(PHONES.A, 5));
      expect([401, 403]).toContain(res.statusCode);
      issuedNoSession(res);
    });

    it('a phone that is linked to a DIFFERENT Firebase UID (recycled number) needs re-verification', async () => {
      const res = await exchange(h.app, tok(PHONES.A, 5, { uid: 'uid-someone-else' }));
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('PHONE_REVERIFY_REQUIRED');
      issuedNoSession(res);
    });

    it('the same Firebase UID cannot be bound to two accounts (database uniqueness)', async () => {
      const b = await ownerB();
      await expect(linkPhoneDirect(h.prisma, b.id, PHONES.B, `uid-${PHONES.A}`)).rejects.toMatchObject({ code: 'P2002' });
      await expect(linkPhoneDirect(h.prisma, b.id, PHONES.A, 'uid-another')).rejects.toMatchObject({ code: 'P2002' });
    });

    it('a replayed ID token is refused the second time', async () => {
      const token = tok(PHONES.A, 5);
      expect((await exchange(h.app, token)).statusCode).toBe(200);
      const again = await exchange(h.app, token);
      expect(again.statusCode, again.body).toBeGreaterThanOrEqual(400);
      issuedNoSession(again);
    });

    it('Firebase outage -> 503 PHONE_LOGIN_UNAVAILABLE (no session, no throttle penalty)', async () => {
      const down: PhoneTokenVerifier = {
        async verify() {
          throw new PhoneVerifierUnavailableError();
        },
        async revokeSessions() {}
      };
      const broken = await startHarness({}, down);
      try {
        const res = await exchange(broken.app, tok(PHONES.A, 5));
        expect(res.statusCode, res.body).toBe(503);
        expect(res.json().error.code).toBe('PHONE_LOGIN_UNAVAILABLE');
        issuedNoSession(res);
      } finally {
        await broken.close();
      }
    });

    it('phone sign-in disabled (no FIREBASE_PROJECT_ID) -> 503', async () => {
      const off = await startHarness({ FIREBASE_PROJECT_ID: '' });
      try {
        const res = await exchange(off.app, tok(PHONES.A, 5));
        expect(res.statusCode).toBe(503);
      } finally {
        await off.close();
      }
    });

    it('a request from a foreign Origin is refused', async () => {
      const res = await exchange(h.app, tok(PHONES.A, 5), 'web', { origin: 'https://evil.example' });
      expect(res.statusCode).toBe(403);
      issuedNoSession(res);
    });
  });

  describe('admin accounts', () => {
    it('an admin can never get a phone session, even with a identity row forced into the database', async () => {
      const admin = await userByEmail(h.prisma, h.world.adminEmail);
      await linkPhoneDirect(h.prisma, admin.id, PHONES.ADMIN);
      const res = await exchange(h.app, tok(PHONES.ADMIN, 5));
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      issuedNoSession(res);
      expect(JSON.stringify(res.json())).not.toContain('PLATFORM_ADMIN');
      const mobile = await exchange(h.app, tok(PHONES.ADMIN, 4), 'mobile');
      expect(mobile.statusCode).toBeGreaterThanOrEqual(400);
      issuedNoSession(mobile);
    });
  });

  describe('web and mobile transports', () => {
    it('return the same user, shop and nextStep; only the session transport differs', async () => {
      await makeShopReady(h.prisma, h.world.a.shopId);
      await linkA();
      const web = await exchange(h.app, tok(PHONES.A, 6), 'web');
      const mobile = await exchange(h.app, tok(PHONES.A, 3), 'mobile');
      expect(web.statusCode, web.body).toBe(200);
      expect(mobile.statusCode, mobile.body).toBe(200);
      const w = dataOf(web);
      const m = dataOf(mobile);
      expect(Object.keys(w.user).sort()).toEqual(Object.keys(m.user).sort());
      expect(Object.keys(w.shop).sort()).toEqual(Object.keys(m.shop).sort());
      expect(m.nextStep).toBe(w.nextStep);
      expect(m.user.id).toBe(w.user.id);
      expect(m.shop.shopName).toBe(w.shop.shopName);
      // web: cookie session + csrf; mobile: the flat Bearer contract (no nested session, no cookie)
      expect(w.session.transport).toBe('cookie');
      expect(w.accessToken).toBeUndefined();
      expect(m.tokenType).toBe('Bearer');
      expect(m.accessToken).toEqual(expect.any(String));
      expect(m.refreshToken).toEqual(expect.any(String));
      expect(m.expiresIn).toBeGreaterThan(800);
      expect(m.refreshTokenExpiresIn).toBeGreaterThan(m.expiresIn);
      expect(m.session).toBeUndefined();
      expect(cookieOf(mobile, 'printout_session')).toBeUndefined();
    });

    it('the mobile bearer token works on the existing shop routes and /auth/session without a CSRF header', async () => {
      await linkA();
      const auth = sessionAuthFrom(await exchange(h.app, tok(PHONES.A, 5), 'mobile'));
      expect(auth).toMatchObject({ kind: 'bearer' });
      expect((await req(h.app, auth, 'GET', '/auth/session')).statusCode).toBe(200);
      expect((await req(h.app, auth, 'GET', '/shop/orders')).statusCode).toBe(200);
      expect((await req(h.app, auth, 'GET', '/users/me')).statusCode).toBe(200);
      // A mutating call carries no CSRF header: bearer credentials are not ambient, so none is required.
      const patch = await req(h.app, auth, 'PATCH', '/users/me', { name: 'Bearer Name' });
      expect(patch.statusCode, patch.body).toBe(200);
    });

    it('a cookie session still requires CSRF on mutations (bearer relaxation does not leak to cookies)', async () => {
      await linkA();
      const auth = sessionAuthFrom(await exchange(h.app, tok(PHONES.A, 5), 'web'));
      if (auth?.kind !== 'cookie') throw new Error('expected cookie auth');
      const noCsrf = await req(h.app, cookieAuth(auth.cookie), 'PATCH', '/users/me', { name: 'x' });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.json().error.code).toBe('CSRF_INVALID');
      const withCsrf = await req(h.app, auth, 'PATCH', '/users/me', { name: 'Fine Name' });
      expect(withCsrf.statusCode, withCsrf.body).toBe(200);
    });

    it('bearer tokens: junk and revoked tokens are 401, and logout ends a bearer session', async () => {
      await linkA();
      expect((await req(h.app, bearerAuth('x'.repeat(40)), 'GET', '/users/me')).statusCode).toBe(401);
      expect((await req(h.app, bearerAuth(''), 'GET', '/users/me')).statusCode).toBe(401);
      const auth = sessionAuthFrom(await exchange(h.app, tok(PHONES.A, 5), 'mobile'));
      expect((await req(h.app, auth, 'POST', '/auth/logout')).statusCode).toBe(204);
      expect((await req(h.app, auth, 'GET', '/users/me')).statusCode).toBe(401);
    });

    it('a sign-in via bearer for owner A never reads shop B', async () => {
      await linkA();
      const auth = sessionAuthFrom(await exchange(h.app, tok(PHONES.A, 5), 'mobile'));
      const orders = await req(h.app, auth, 'GET', `/shop/orders/${h.world.b.shopId}`);
      expect([403, 404]).toContain(orders.statusCode);
    });
  });

  describe('email/password sign-in is unchanged', () => {
    it('POST /auth/login still returns exactly the pre-existing payload shape', async () => {
      const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: h.world.a.ownerEmail, password: PASSWORD } });
      expect(res.statusCode).toBe(200);
      const d = res.json().data;
      expect(Object.keys(d).sort()).toEqual(['csrfToken', 'retentionMinutes', 'shop', 'user']);
      expect(Object.keys(d.user).sort()).toEqual(['displayName', 'id', 'role']);
      expect(d.user.role).toBe('SHOP_OWNER');
      expect(Object.keys(d.shop).sort()).toEqual(['displayName', 'id', 'slug']);
      expect(cookieOf(res, 'printout_session')).toBeTruthy();
    });

    it('wrong passwords and unknown accounts still return the generic 401', async () => {
      const bad = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: h.world.a.ownerEmail, password: 'wrong-password-123' } });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  it('mints a distinct, well-formed project identity for tests (sanity)', () => {
    expect(PROJECT).toMatch(/^[a-z0-9-]+$/);
  });
});
