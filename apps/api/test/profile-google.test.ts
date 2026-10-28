import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenHash } from '../src/auth.js';
import { PhoneVerifierUnavailableError, type PhoneTokenVerifier } from '../src/firebase/verifier.js';
import { PASSWORD, call } from './api-helpers.js';
import {
  bearerAuth, collectKeys, DEVICE_A, DEVICE_B, exchange, FORBIDDEN_KEYS, gtok, linkPhoneDirect, makeShopReady, makeShoplessOwner, ONBOARDING_BODY, PHONES,
  refresh, req, startHarness, tok, userByEmail, type Auth, type Harness
} from './helpers/profile-harness.js';

/** Google sign-in through Firebase: POST /auth {loginMethod:'google'} plus link/unlink under /users/me/identities/google. */
const INSTALL = DEVICE_A;
const FCM_1 = 'fcm-google-login-ONE-0123456789-abcdefghijklmnopqrstuvwxyz';
const OWNER_G = 'owner.sharma@gmail.test'; // Google account linked to shop A's owner
const NEWBIE = 'newbie.asha@gmail.test';
const { ownerName, shopName, address, pincode } = ONBOARDING_BODY;
const ONBOARD_NO_EMAIL = { ownerName, shopName, address, pincode, client: 'mobile', deviceId: INSTALL };

describe('Google sign-in (loginMethod google) and Google identity linking', () => {
  let h: Harness;
  let age = 280;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    age = 280;
    await makeShopReady(h.prisma, h.world.a.shopId);
    await makeShopReady(h.prisma, h.world.b.shopId);
  });

  const next = () => age--;
  const g = (email: string, o: Parameters<typeof gtok>[1] = {}) => gtok(email, { ago: next(), ...o });
  const authCall = (body: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/api/v1/auth', payload: body });
  const google = (idToken: string, extra: Record<string, unknown> = {}, installationId = INSTALL) =>
    authCall({ loginMethod: 'google', firebaseIdToken: idToken, installationId, platform: 'android', ...extra });
  const emailLogin = (email: string, password: string = PASSWORD, installationId = INSTALL) =>
    authCall({ loginMethod: 'email', email, password, installationId, platform: 'android' });
  const data = (r: LightMyRequestResponse) => r.json().data as Record<string, any>;
  const bearer = (r: LightMyRequestResponse): Auth => bearerAuth(data(r).accessToken);
  const me = (r: LightMyRequestResponse | string | Auth) =>
    req(h.app, typeof r === 'string' ? bearerAuth(r) : r && 'kind' in r ? r : bearerAuth(data(r as LightMyRequestResponse).accessToken), 'GET', '/users/me');
  const noTokens = (r: LightMyRequestResponse) => {
    expect(r.body).not.toMatch(/"(accessToken|refreshToken)"/);
    expect(r.cookies.length).toBe(0);
  };
  const ownerId = async (email = h.world.a.ownerEmail) => (await userByEmail(h.prisma, email)).id;
  /** Fixture: bind a Google identity straight in the database (the API path is tested separately). */
  const linkGoogleDirect = async (userId: string, email: string, uid = `guid-${email.toLowerCase()}`) =>
    h.prisma.userGoogleIdentity.create({ data: { userId, firebaseUid: uid, email, linkedAt: new Date() } as never });
  const googleRows = (userId?: string) => h.prisma.userGoogleIdentity.findMany({ where: userId ? { userId } : {} });
  const linkReq = (auth: Auth, body: unknown) => req(h.app, auth, 'POST', '/users/me/identities/google', body);
  const unlinkReq = (auth: Auth, body: unknown) => req(h.app, auth, 'POST', '/users/me/identities/google/unlink', body);
  /** A signed-in owner A (email) with a Bearer token. */
  const signedInA = async () => bearer(await emailLogin(h.world.a.ownerEmail));
  /** Creates a password-less owner whose only sign-in method is Google, through the real onboarding path. */
  async function googleOnlyOwner(email = NEWBIE) {
    const restricted = await google(g(email));
    expect(restricted.statusCode, restricted.body).toBe(200);
    const created = await req(h.app, bearer(restricted), 'POST', '/shops/onboarding', ONBOARD_NO_EMAIL);
    expect([200, 201], created.body).toContain(created.statusCode);
    return { restricted, userId: await ownerId(email) };
  }
  const audits = () => h.prisma.auditLog.findMany();

  describe('login: linked owner', () => {
    it('a linked Google identity signs in to its account: normal Bearer pair, dashboard, google in loginMethods', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      const res = await google(g(OWNER_G));
      expect(res.statusCode, res.body).toBe(200);
      const d = data(res);
      expect(d).toMatchObject({ tokenType: 'Bearer', nextStep: 'dashboard', isShopRegisteredAtLeastOne: true, showQr: true });
      expect(d.expiresIn).toBeGreaterThan(890);
      expect(d.user).toMatchObject({ id: await ownerId(), role: 'shop', email: h.world.a.ownerEmail });
      expect(d.user.loginMethods).toContain('google');
      expect(d.shops).toHaveLength(1);
      expect(d.shops[0].id).toBe(h.world.a.shopId);
      expect(d.session).toBeUndefined();
      expect((await me(res)).statusCode).toBe(200);
      for (const k of [...FORBIDDEN_KEYS, 'installationId']) expect(collectKeys(res.json()).has(k), k).toBe(false);
    });

    it('emailVerified is true only when the linked Google email equals the account email', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkGoogleDirect(owner.id, OWNER_G); // different from owner@a.test
      expect(data(await google(g(OWNER_G))).user.emailVerified).toBe(false);
      await h.prisma.userGoogleIdentity.deleteMany({ where: { userId: owner.id } });
      await linkGoogleDirect(owner.id, h.world.a.ownerEmail.toUpperCase());
      expect(data(await google(g(h.world.a.ownerEmail, { uid: `guid-${h.world.a.ownerEmail.toUpperCase().toLowerCase()}` }))).user.emailVerified).toBe(true);
    });

    it('QR / shop routing for Google sign-ins: no shop -> create_shop, PILOT -> generate_qr, incomplete -> complete_profile', async () => {
      const shopless = await makeShoplessOwner(h.prisma);
      await linkGoogleDirect(shopless.id, 'shopless@gmail.test');
      expect(data(await google(g('shopless@gmail.test')))).toMatchObject({ nextStep: 'create_shop', isShopRegisteredAtLeastOne: false, showQr: false, shops: [] });

      await linkGoogleDirect(await ownerId(), OWNER_G);
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'PILOT' } });
      const pilot = data(await google(g(OWNER_G)));
      expect(pilot).toMatchObject({ nextStep: 'generate_qr', showQr: false });
      expect(pilot.shops[0].qrCodeUrl).toBeNull();
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'ACTIVE', address: null } });
      expect(data(await google(g(OWNER_G))).nextStep).toBe('complete_profile');
    });

    it('issues a rotating pair: the refresh token renews it (deviceId = installationId) and the old one is spent', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      const d = data(await google(g(OWNER_G)));
      const rotated = await refresh(h.app, d.refreshToken, INSTALL);
      expect(rotated.statusCode, rotated.body).toBe(200);
      const pair = rotated.json().data.session ?? rotated.json().data;
      expect(pair.accessToken).not.toBe(d.accessToken);
      expect((await me(pair.accessToken)).statusCode).toBe(200);
      expect((await me(d.accessToken)).statusCode).toBe(401);
      expect((await refresh(h.app, d.refreshToken, INSTALL)).statusCode).toBe(409); // just-used token, grace window
    });

    it('registers an fcmToken only after a successful Google sign-in; a failed one registers nothing', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      const bad = await google(g(OWNER_G, { emailVerified: false }), { fcmToken: FCM_1 });
      expect(bad.statusCode).toBe(401);
      expect(await h.prisma.fcmRegistration.count()).toBe(0);
      const ok = await google(g(OWNER_G), { fcmToken: FCM_1, platform: 'ios' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.body).not.toContain(FCM_1);
      const [row] = await h.prisma.fcmRegistration.findMany();
      expect(row).toMatchObject({ installationId: INSTALL, platform: 'ios', shopId: h.world.a.shopId, tokenHash: tokenHash(FCM_1) });
      expect(row!.tokenCipher).not.toContain(FCM_1);
    });
  });

  describe('token verification', () => {
    beforeEach(async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
    });
    const invalid: Array<[string, () => string]> = [
      ['garbage', () => 'garbage-token-garbage-token-garbage'],
      ['wrong Firebase project', () => g(OWNER_G, { projectId: 'some-other-project' })],
      ['wrong audience only', () => g(OWNER_G, { aud: 'some-other-project' })],
      ['wrong issuer only', () => g(OWNER_G, { iss: 'https://securetoken.google.com/some-other-project' })],
      ['expired', () => g(OWNER_G, { ago: 7200, exp: Math.floor(Date.now() / 1000) - 60 })],
      ['authenticated too long ago', () => g(OWNER_G, { ago: 7200 })],
      ['unverified email', () => g(OWNER_G, { emailVerified: false })],
      ['email_verified claim missing', () => g(OWNER_G, { emailVerified: undefined })],
      ['no email claim', () => g(OWNER_G, { noEmail: true })],
      ['a phone sign-in token', () => tok(PHONES.A, next())],
      ['password provider', () => g(OWNER_G, { provider: 'password' })]
    ];
    it.each(invalid)('refuses %s with 401 GOOGLE_TOKEN_INVALID and issues nothing', async (_n, make) => {
      const res = await google(make());
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe('GOOGLE_TOKEN_INVALID');
      noTokens(res);
    });

    it('a Google token is not accepted by the OTP login and a phone token is not accepted by Google login', async () => {
      const viaOtp = await authCall({ loginMethod: 'otp', firebaseIdToken: g(OWNER_G), installationId: INSTALL, platform: 'android' });
      expect([400, 401]).toContain(viaOtp.statusCode);
      noTokens(viaOtp);
    });

    it('a replayed Google token is refused the second time', async () => {
      const t = g(OWNER_G);
      expect((await google(t)).statusCode).toBe(200);
      const again = await google(t);
      expect(again.statusCode).toBeGreaterThanOrEqual(400);
      noTokens(again);
    });

    it('rejects bad request shapes with 400: missing token, missing installationId, bad platform, extra keys', async () => {
      const t = () => g(OWNER_G);
      const bad: Array<Record<string, unknown>> = [
        { loginMethod: 'google', installationId: INSTALL, platform: 'android' },
        { loginMethod: 'google', firebaseIdToken: t(), platform: 'android' },
        { loginMethod: 'google', firebaseIdToken: t(), installationId: INSTALL, platform: 'blackberry' },
        { loginMethod: 'google', firebaseIdToken: 12345, installationId: INSTALL, platform: 'android' }
      ];
      for (const body of bad) {
        const res = await authCall(body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 70)).toBe(400);
        noTokens(res);
      }
    });

    it('a Firebase-disabled Google user is refused', async () => {
      h.emulator.disabled.add(`guid-${OWNER_G}`);
      const res = await google(g(OWNER_G));
      expect([401, 403]).toContain(res.statusCode);
      noTokens(res);
    });

    it('Firebase outage -> 503 GOOGLE_LOGIN_UNAVAILABLE and no tokens', async () => {
      const down: PhoneTokenVerifier = {
        async verify() {
          throw new PhoneVerifierUnavailableError();
        },
        async revokeSessions() {}
      };
      const broken = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true' }, down);
      try {
        const res = await broken.app.inject({
          method: 'POST',
          url: '/api/v1/auth',
          payload: { loginMethod: 'google', firebaseIdToken: gtok(OWNER_G), installationId: INSTALL, platform: 'android' }
        });
        expect(res.statusCode, res.body).toBe(503);
        expect(res.json().error.code).toBe('GOOGLE_LOGIN_UNAVAILABLE');
        noTokens(res);
      } finally {
        await broken.close();
      }
    });
  });

  describe('feature flag', () => {
    it('GOOGLE_LOGIN_ENABLED defaults to false: Google sign-in and linking answer 503 and nothing is created', async () => {
      const off = await startHarness({ GOOGLE_LOGIN_ENABLED: '__unset__' });
      try {
        const before = { users: await off.prisma.user.count(), refresh: await off.prisma.refreshToken.count() };
        const res = await off.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'google', firebaseIdToken: gtok(NEWBIE), installationId: INSTALL, platform: 'android' } });
        expect(res.statusCode, res.body).toBe(503);
        expect(res.json().error.code).toBe('GOOGLE_LOGIN_UNAVAILABLE');
        noTokens(res);
        expect(await off.prisma.user.count()).toBe(before.users);
        expect(await off.prisma.refreshToken.count()).toBe(before.refresh);
        // linking is switched off with the same flag
        const login = await off.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'email', email: off.world.a.ownerEmail, password: PASSWORD, installationId: INSTALL, platform: 'android' } });
        const link = await req(off.app, bearerAuth(login.json().data.accessToken), 'POST', '/users/me/identities/google', { firebaseIdToken: gtok(NEWBIE), reauth: { currentPassword: PASSWORD } });
        expect([503, 404]).toContain(link.statusCode);
        expect(await off.prisma.userGoogleIdentity.count()).toBe(0);
      } finally {
        await off.close();
      }
    });

    it('email and OTP sign-in are unaffected by the Google flag being off', async () => {
      const off = await startHarness({ GOOGLE_LOGIN_ENABLED: '__unset__' });
      try {
        const res = await off.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'email', email: off.world.a.ownerEmail, password: PASSWORD, installationId: INSTALL, platform: 'android' } });
        expect(res.statusCode, res.body).toBe(200);
      } finally {
        await off.close();
      }
    });
  });

  describe('resolution by Firebase UID only (never by email)', () => {
    it('a Google account whose email EQUALS an existing owner’s email but whose UID is not linked gets a restricted pair, never that account', async () => {
      const res = await google(g(h.world.a.ownerEmail, { uid: 'guid-someone-pretending' }));
      expect(res.statusCode, res.body).toBe(200);
      const d = data(res);
      expect(d).toMatchObject({ nextStep: 'create_shop', isShopRegisteredAtLeastOne: false, shops: [] });
      expect(d.user.role ?? null).toBeNull();
      expect(d.user.id ?? null).not.toBe(await ownerId());
      const shop = await req(h.app, bearer(res), 'GET', '/shops/me');
      expect([401, 403, 404]).toContain(shop.statusCode);
      const orders = await req(h.app, bearer(res), 'GET', '/shop/orders');
      expect([401, 403]).toContain(orders.statusCode);
      expect(await h.prisma.userGoogleIdentity.count()).toBe(0);
    });

    it('a matching phone number or email does not link or merge anything by itself', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkPhoneDirect(h.prisma, owner.id, PHONES.A);
      const res = await google(g('stranger@gmail.test'));
      expect(data(res).nextStep).toBe('create_shop');
      expect(await googleRows()).toHaveLength(0);
    });

    it('an admin’s email on an unlinked Google account never yields admin access', async () => {
      const res = await google(g(h.world.adminEmail, { uid: 'guid-fake-admin' }));
      expect(res.statusCode, res.body).toBe(200);
      expect(data(res).user.role ?? null).toBeNull();
      expect((await req(h.app, bearer(res), 'GET', '/admin/shops')).statusCode).toBeGreaterThanOrEqual(401);
      const created = await req(h.app, bearer(res), 'POST', '/shops/onboarding', ONBOARD_NO_EMAIL);
      expect(created.statusCode, created.body).toBe(409);
      expect(created.json().error.code).toBe('EMAIL_UNAVAILABLE');
    });
  });

  describe('new Google user (no account)', () => {
    it('gets a restricted access+refresh pair, create_shop, no shops, Google email on the identity; nothing is created', async () => {
      const users = await h.prisma.user.count();
      const shops = await h.prisma.shop.count();
      const res = await google(g(NEWBIE));
      expect(res.statusCode, res.body).toBe(200);
      const d = data(res);
      expect(d).toMatchObject({ tokenType: 'Bearer', nextStep: 'create_shop', isShopRegisteredAtLeastOne: false, showQr: false, shops: [] });
      expect(d.accessToken).toEqual(expect.any(String));
      expect(d.refreshToken).toEqual(expect.any(String));
      expect(d.user.role ?? null).toBeNull();
      expect(d.user.email).toBe(NEWBIE);
      expect(d.user.loginMethods).toContain('google');
      expect(await h.prisma.user.count()).toBe(users);
      expect(await h.prisma.shop.count()).toBe(shops);
      expect((await me(res)).statusCode).toBe(200);
      for (const url of ['/shops/me', '/shops/me/qr', '/shop/orders', '/shop/settings']) {
        expect([401, 403, 404], url).toContain((await req(h.app, bearer(res), 'GET', url)).statusCode);
      }
    });

    it('an fcmToken sent by a restricted Google identity is not stored', async () => {
      const res = await google(g(NEWBIE), { fcmToken: FCM_1 });
      expect(res.statusCode).toBe(200);
      expect(await h.prisma.fcmRegistration.count()).toBe(0);
    });

    it('onboarding with the Google grant uses the verified email (body email absent): creates user + shop + Google link, active shop, no plan', async () => {
      const restricted = await google(g(NEWBIE));
      const created = await req(h.app, bearer(restricted), 'POST', '/shops/onboarding', ONBOARD_NO_EMAIL);
      expect([200, 201], created.body).toContain(created.statusCode);
      const user = await h.prisma.user.findUniqueOrThrow({ where: { email: NEWBIE }, include: { shop: true } });
      expect(user.role).toBe('SHOP_OWNER');
      expect(user.shop).toMatchObject({ displayName: shopName, status: 'ACTIVE', acceptsOrders: true });
      expect(await h.prisma.subscription.count({ where: { shopId: user.shopId! } })).toBe(0);
      const links = await googleRows(user.id);
      expect(links).toHaveLength(1);
      expect(links[0]!.firebaseUid).toBe(`guid-${NEWBIE}`);
      // a normal pair now: a fresh Google sign-in goes straight to dashboard with the new shop
      const again = await google(g(NEWBIE));
      expect(again.statusCode, again.body).toBe(200);
      expect(data(again)).toMatchObject({ nextStep: 'dashboard', isShopRegisteredAtLeastOne: true, showQr: true });
      expect(data(again).user.role).toBe('shop');
      expect(data(again).user.emailVerified).toBe(true); // linked Google email == account email
    });

    it('a body email equal to the verified email is accepted; a different one is refused and creates nothing', async () => {
      const restricted = await google(g(NEWBIE));
      const different = await req(h.app, bearer(restricted), 'POST', '/shops/onboarding', { ...ONBOARD_NO_EMAIL, email: 'other@gmail.test' });
      expect(different.statusCode, different.body).toBeGreaterThanOrEqual(400);
      expect(different.statusCode).toBeLessThan(500);
      expect(await h.prisma.user.count({ where: { email: { in: ['other@gmail.test', NEWBIE] } } })).toBe(0);
      const same = await req(h.app, bearer(restricted), 'POST', '/shops/onboarding', { ...ONBOARD_NO_EMAIL, email: NEWBIE.toUpperCase() });
      expect([200, 201], same.body).toContain(same.statusCode);
      expect(await h.prisma.user.count({ where: { email: NEWBIE } })).toBe(1);
    });

    it('email collision: an existing account with that email -> 409 EMAIL_UNAVAILABLE, nothing is merged or linked', async () => {
      const restricted = await google(g(h.world.b.ownerEmail, { uid: 'guid-collision' }));
      const before = { users: await h.prisma.user.count(), shops: await h.prisma.shop.count() };
      const res = await req(h.app, bearer(restricted), 'POST', '/shops/onboarding', ONBOARD_NO_EMAIL);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_UNAVAILABLE');
      expect(await h.prisma.user.count()).toBe(before.users);
      expect(await h.prisma.shop.count()).toBe(before.shops);
      expect(await googleRows()).toHaveLength(0);
      const b = await userByEmail(h.prisma, h.world.b.ownerEmail);
      expect(b.shopId).toBe(h.world.b.shopId);
      expect(await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.b.shopId } })).toMatchObject({ displayName: 'Metro Copies' });
    });

    it('a Google-onboarded account has no usable password: email sign-in fails with the generic 401', async () => {
      await googleOnlyOwner();
      const res = await emailLogin(NEWBIE, 'password1234567');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    });

    it('concurrent onboarding with one Google grant creates exactly one account', async () => {
      const restricted = await google(g(NEWBIE));
      const before = { users: await h.prisma.user.count(), shops: await h.prisma.shop.count(), links: await h.prisma.userGoogleIdentity.count() };
      const results = await Promise.all(Array.from({ length: 5 }, () => req(h.app, bearer(restricted), 'POST', '/shops/onboarding', ONBOARD_NO_EMAIL)));
      for (const r of results) expect([200, 201, 401, 409], r.body).toContain(r.statusCode);
      expect(await h.prisma.user.count()).toBe(before.users + 1);
      expect(await h.prisma.shop.count()).toBe(before.shops + 1);
      expect(await h.prisma.userGoogleIdentity.count()).toBe(before.links + 1);
    });

    it('a duplicate account cannot be created for a Google identity that already has one', async () => {
      await googleOnlyOwner();
      const again = await google(g(NEWBIE));
      expect(data(again).nextStep).not.toBe('create_shop');
      const stale = await google(g(NEWBIE)); // another sign-in resolves to the SAME account
      expect(data(stale).user.id).toBe(data(again).user.id);
      expect(await h.prisma.user.count({ where: { email: NEWBIE } })).toBe(1);
    });
  });

  describe('blocked accounts', () => {
    it('a suspended shop: 403 ACCOUNT_BLOCKED, details.nextStep account_blocked, no tokens, no fcm registration', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'SUSPENDED' } });
      const res = await google(g(OWNER_G), { fcmToken: FCM_1 });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('ACCOUNT_BLOCKED');
      expect(res.json().error.details.nextStep).toBe('account_blocked');
      noTokens(res);
      expect(await h.prisma.fcmRegistration.count()).toBe(0);
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'ACTIVE' } });
      expect((await google(g(OWNER_G))).statusCode).toBe(200);
    });

    it('an admin with a forced Google identity is refused (403) with no tokens, and Admin 2FA password login is unchanged', async () => {
      const admin = await userByEmail(h.prisma, h.world.adminEmail);
      await linkGoogleDirect(admin.id, 'admin.person@gmail.test');
      const res = await google(g('admin.person@gmail.test'));
      expect(res.statusCode, res.body).toBe(403);
      noTokens(res);
      expect(await h.prisma.refreshToken.count({ where: { userId: admin.id } })).toBe(0);
      const web = await call(h.app, null, 'POST', '/auth/login', { email: h.world.adminEmail, password: PASSWORD });
      expect(web.statusCode).toBe(200);
      expect(Object.keys(web.json().data).sort()).toEqual(expect.arrayContaining(['csrfToken', 'user']));
    });
  });

  describe('linking: POST /users/me/identities/google', () => {
    it('links with PASSWORD reauth: 200, google now in loginMethods, Google sign-in works, other devices are signed out, audited', async () => {
      const a = await emailLogin(h.world.a.ownerEmail, PASSWORD, DEVICE_A);
      const other = await emailLogin(h.world.a.ownerEmail, PASSWORD, DEVICE_B);
      const res = await linkReq(bearer(a), { firebaseIdToken: g(OWNER_G), reauth: { currentPassword: PASSWORD } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain(PASSWORD);
      const rows = await googleRows(await ownerId());
      expect(rows).toHaveLength(1);
      expect(rows[0]!.firebaseUid).toBe(`guid-${OWNER_G}`);
      expect((await me(a)).json().data.loginMethods ?? (await me(a)).json().data.user?.loginMethods).toContain('google');
      expect((await me(a)).statusCode).toBe(200); // the acting session survives
      expect((await me(other)).statusCode).toBe(401); // every OTHER session is ended
      expect((await refresh(h.app, data(other).refreshToken, DEVICE_B)).statusCode).toBe(401);
      expect((await google(g(OWNER_G))).statusCode).toBe(200);
      const trail = (await audits()).filter((r) => /google/i.test(r.action));
      expect(trail.length).toBeGreaterThan(0);
      const blob = JSON.stringify(trail);
      for (const secret of [PASSWORD, OWNER_G, `guid-${OWNER_G}`]) expect(blob.includes(secret), secret).toBe(false);
    });

    it('links with fresh PHONE-token reauth (a linked phone proves the owner)', async () => {
      await linkPhoneDirect(h.prisma, await ownerId(), PHONES.A);
      const a = await signedInA();
      const res = await linkReq(a, { firebaseIdToken: g(OWNER_G), reauth: { firebaseIdToken: tok(PHONES.A, next()) } });
      expect(res.statusCode, res.body).toBe(200);
      expect(await googleRows(await ownerId())).toHaveLength(1);
    });

    it('refuses without reauth, with a wrong password, with a stale reauth token, and with another user’s token: nothing is linked', async () => {
      await linkPhoneDirect(h.prisma, await ownerId(), PHONES.A);
      await linkPhoneDirect(h.prisma, await ownerId(h.world.b.ownerEmail), PHONES.B);
      const a = await signedInA();
      const attempts: Array<[string, unknown, number[]]> = [
        ['no reauth', { firebaseIdToken: g(OWNER_G) }, [400]],
        ['empty reauth', { firebaseIdToken: g(OWNER_G), reauth: {} }, [400]],
        ['wrong password', { firebaseIdToken: g(OWNER_G), reauth: { currentPassword: 'definitely-wrong-1' } }, [401, 403]],
        ['stale phone token', { firebaseIdToken: g(OWNER_G), reauth: { firebaseIdToken: tok(PHONES.A, 3600) } }, [401, 403]],
        ["another user's phone token", { firebaseIdToken: g(OWNER_G), reauth: { firebaseIdToken: tok(PHONES.B, next()) } }, [401, 403]],
        ['an unlinked phone token', { firebaseIdToken: g(OWNER_G), reauth: { firebaseIdToken: tok(PHONES.NEW, next()) } }, [401, 403]],
        ['both reauth forms', { firebaseIdToken: g(OWNER_G), reauth: { currentPassword: PASSWORD, firebaseIdToken: tok(PHONES.A, next()) } }, [400, 200]]
      ];
      for (const [name, body, codes] of attempts) {
        const res = await linkReq(a, body);
        expect(codes, `${name}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
        if (res.statusCode !== 200) expect(await googleRows()).toHaveLength(0);
        else await h.prisma.userGoogleIdentity.deleteMany({});
      }
    });

    it('refuses an invalid Google token for linking (401 GOOGLE_TOKEN_INVALID), including unverified email and a wrong project', async () => {
      const a = await signedInA();
      for (const bad of [g(OWNER_G, { emailVerified: false }), g(OWNER_G, { projectId: 'other-project' }), g(OWNER_G, { provider: 'phone' }), 'garbage-token-garbage-token']) {
        const res = await linkReq(a, { firebaseIdToken: bad, reauth: { currentPassword: PASSWORD } });
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json().error.code).toBe('GOOGLE_TOKEN_INVALID');
      }
      expect(await googleRows()).toHaveLength(0);
    });

    it('a Google UID already linked to another account -> 409 GOOGLE_IDENTITY_UNAVAILABLE, nothing changes', async () => {
      await linkGoogleDirect(await ownerId(h.world.b.ownerEmail), OWNER_G);
      const a = await signedInA();
      const res = await linkReq(a, { firebaseIdToken: g(OWNER_G), reauth: { currentPassword: PASSWORD } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('GOOGLE_IDENTITY_UNAVAILABLE');
      expect(await googleRows(await ownerId())).toHaveLength(0);
      expect(await googleRows(await ownerId(h.world.b.ownerEmail))).toHaveLength(1);
      // the error does not reveal whose it is
      expect(res.body).not.toContain(h.world.b.ownerEmail);
    });

    it('two owners racing to link the same Google UID: exactly one wins', async () => {
      const a = await signedInA();
      const b = bearer(await emailLogin(h.world.b.ownerEmail, PASSWORD, DEVICE_B));
      const t1 = g(OWNER_G);
      const t2 = g(OWNER_G);
      const [r1, r2] = await Promise.all([linkReq(a, { firebaseIdToken: t1, reauth: { currentPassword: PASSWORD } }), linkReq(b, { firebaseIdToken: t2, reauth: { currentPassword: PASSWORD } })]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes[0]).toBe(200);
      expect([409, 401]).toContain(codes[1]);
      expect(await googleRows()).toHaveLength(1);
    });

    it('requires a shop-owner session: anonymous 401, restricted grant 401/403, admin 403', async () => {
      expect((await linkReq(null, { firebaseIdToken: g(OWNER_G), reauth: { currentPassword: PASSWORD } })).statusCode).toBe(401);
      const restricted = await google(g(NEWBIE));
      expect([401, 403]).toContain((await linkReq(bearer(restricted), { firebaseIdToken: g(NEWBIE), reauth: { currentPassword: PASSWORD } })).statusCode);
      const admin = await call(h.app, null, 'POST', '/auth/login', { email: h.world.adminEmail, password: PASSWORD });
      expect(admin.statusCode).toBe(200);
      const adminAuth: Auth = { kind: 'cookie', cookie: `printout_session=${admin.cookies.find((c) => c.name === 'printout_session')!.value}`, csrf: admin.json().data.csrfToken };
      expect([403]).toContain((await linkReq(adminAuth, { firebaseIdToken: g('adm@gmail.test'), reauth: { currentPassword: PASSWORD } })).statusCode);
      expect(await googleRows()).toHaveLength(0);
    });

    it('replacing: linking a different Google account swaps the identity and frees the old UID for others', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkGoogleDirect(owner.id, OWNER_G);
      const a = await signedInA();
      const res = await linkReq(a, { firebaseIdToken: g('second.google@gmail.test'), reauth: { currentPassword: PASSWORD } });
      expect(res.statusCode, res.body).toBe(200);
      const rows = await googleRows(owner.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.firebaseUid).toBe('guid-second.google@gmail.test');
      // the old Google account is no longer this owner's sign-in...
      expect(data(await google(g(OWNER_G))).nextStep).toBe('create_shop');
      // ...and can be linked by someone else
      const b = bearer(await emailLogin(h.world.b.ownerEmail, PASSWORD, DEVICE_B));
      expect((await linkReq(b, { firebaseIdToken: g(OWNER_G), reauth: { currentPassword: PASSWORD } })).statusCode).toBe(200);
    });

    it('is idempotent for the same Google account (no duplicate rows)', async () => {
      const a = await signedInA();
      expect((await linkReq(a, { firebaseIdToken: g(OWNER_G), reauth: { currentPassword: PASSWORD } })).statusCode).toBe(200);
      const again = await linkReq(a, { firebaseIdToken: g(OWNER_G), reauth: { currentPassword: PASSWORD } });
      expect([200, 409]).toContain(again.statusCode);
      expect(await googleRows(await ownerId())).toHaveLength(1);
    });
  });

  describe('unlinking: POST /users/me/identities/google/unlink', () => {
    it('unlinks with password reauth: Google sign-in then yields a restricted pair; other sessions are ended; audited', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkGoogleDirect(owner.id, OWNER_G);
      const a = bearer(await emailLogin(h.world.a.ownerEmail, PASSWORD, DEVICE_A));
      const other = await emailLogin(h.world.a.ownerEmail, PASSWORD, DEVICE_B);
      const res = await unlinkReq(a, { reauth: { currentPassword: PASSWORD } });
      expect(res.statusCode, res.body).toBe(200);
      expect(await googleRows(owner.id)).toHaveLength(0);
      expect((await me(other)).statusCode).toBe(401);
      expect(data(await google(g(OWNER_G))).nextStep).toBe('create_shop');
      expect((await audits()).some((r) => /google.*unlink|unlink.*google/i.test(r.action))).toBe(true);
    });

    it('needs reauth: none or a wrong password changes nothing', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkGoogleDirect(owner.id, OWNER_G);
      const a = await signedInA();
      expect([400, 401, 403]).toContain((await unlinkReq(a, {})).statusCode);
      expect([401, 403]).toContain((await unlinkReq(a, { reauth: { currentPassword: 'definitely-wrong-1' } })).statusCode);
      expect(await googleRows(owner.id)).toHaveLength(1);
    });

    it('LAST_SIGNIN_METHOD: a Google-only (password-less) owner cannot unlink their only method', async () => {
      const { userId } = await googleOnlyOwner();
      const signed = bearer(await google(g(NEWBIE)));
      const res = await unlinkReq(signed, { reauth: { firebaseIdToken: g(NEWBIE) } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('LAST_SIGNIN_METHOD');
      expect(await googleRows(userId)).toHaveLength(1);
      expect((await me(signed)).statusCode).toBe(200);
    });

    it('a password-less owner CAN unlink Google once another method (a linked phone) exists', async () => {
      const { userId } = await googleOnlyOwner();
      await linkPhoneDirect(h.prisma, userId, PHONES.NEW);
      const signed = bearer(await google(g(NEWBIE)));
      const res = await unlinkReq(signed, { reauth: { firebaseIdToken: g(NEWBIE) } });
      expect(res.statusCode, res.body).toBe(200);
      expect(await googleRows(userId)).toHaveLength(0);
    });

    it('an owner who still has a password can always unlink', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      expect((await unlinkReq(await signedInA(), { reauth: { currentPassword: PASSWORD } })).statusCode).toBe(200);
    });

    it('phone link and unlink accept token reauth for a password-less owner (and still refuse stale ones)', async () => {
      const { userId } = await googleOnlyOwner();
      const signed = bearer(await google(g(NEWBIE)));
      const stale = await req(h.app, signed, 'POST', '/shop/account/phone', { idToken: tok(PHONES.NEW, next()), reauthIdToken: g(NEWBIE, { ago: 3600 }) });
      expect([401, 403]).toContain(stale.statusCode);
      expect(await h.prisma.userPhoneIdentity.count({ where: { userId } })).toBe(0);
      const ok = await req(h.app, signed, 'POST', '/shop/account/phone', { idToken: tok(PHONES.NEW, next()), reauthIdToken: g(NEWBIE) });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await h.prisma.userPhoneIdentity.count({ where: { userId } })).toBe(1);
      const unlink = await req(h.app, signed, 'POST', '/shop/account/phone/unlink', { reauthIdToken: g(NEWBIE) });
      expect(unlink.statusCode, unlink.body).toBe(200);
      expect(await h.prisma.userPhoneIdentity.count({ where: { userId } })).toBe(0);
    });
  });

  describe('isolation and secrecy', () => {
    it('a Google-signed-in owner A never sees shop B, and B’s Google identity is not A’s', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      await linkGoogleDirect(await ownerId(h.world.b.ownerEmail), 'owner.metro@gmail.test');
      const a = await google(g(OWNER_G));
      const shops = data(a).shops;
      expect(shops.map((s: any) => s.id)).toEqual([h.world.a.shopId]);
      const mine = (await req(h.app, bearer(a), 'GET', '/shops/me')).json().data;
      expect(JSON.stringify(mine)).toContain('Sharma Print');
      expect(JSON.stringify(mine)).not.toContain('Metro Copies');
      expect((await req(h.app, bearer(a), 'GET', `/shop/orders/${h.world.b.shopId}`)).statusCode).toBeGreaterThanOrEqual(403);
    });

    it('no Google token, email, UID, password or session token ever lands in audit rows or error bodies', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      const t = g(OWNER_G);
      const ok = await google(t);
      const bad = await google(g(OWNER_G, { emailVerified: false }));
      const blob = JSON.stringify(await audits());
      for (const secret of [t, data(ok).accessToken, data(ok).refreshToken, OWNER_G, `guid-${OWNER_G}`]) expect(blob.includes(secret), secret.slice(0, 12)).toBe(false);
      expect(bad.body).not.toContain(OWNER_G);
    });

    it('/users/me for a Google-linked owner never exposes the Firebase UID or the identity table', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      const res = await google(g(OWNER_G));
      const who = await me(res);
      expect(who.body).not.toContain(`guid-${OWNER_G}`);
      for (const k of [...FORBIDDEN_KEYS, 'firebaseUid', 'googleUid']) expect(collectKeys(who.json()).has(k), k).toBe(false);
    });

    it('email, OTP and the web exchange still work for the same account after Google is linked', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      await linkPhoneDirect(h.prisma, await ownerId(), PHONES.A);
      expect((await emailLogin(h.world.a.ownerEmail)).statusCode).toBe(200);
      expect((await authCall({ loginMethod: 'otp', firebaseIdToken: tok(PHONES.A, next()), installationId: INSTALL, platform: 'android' })).statusCode).toBe(200);
      expect((await exchange(h.app, tok(PHONES.A, next()), 'web')).statusCode).toBe(200);
    });
  });

  describe('web Google sign-in (POST /auth/google/session)', () => {
    const webGoogle = (idToken: string, headers: Record<string, string> = { origin: 'http://localhost:5173' }) =>
      h.app.inject({ method: 'POST', url: '/api/v1/auth/google/session', payload: { idToken }, headers });

    it('exchanges a linked Google token for a session cookie and csrfToken', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      const res = await webGoogle(g(OWNER_G));
      expect(res.statusCode, res.body).toBe(200);
      const cookie = res.cookies.find((c) => c.name === 'printout_session');
      expect(cookie).toBeTruthy();
      expect(cookie?.httpOnly).toBe(true);
      const d = data(res);
      expect(d.csrfToken).toBeTruthy();
      expect(d.user.id).toBe(await ownerId());
      expect(d.user.role).toBe('SHOP_OWNER');
      expect(d.shop?.id).toBe(h.world.a.shopId);
    });

    it('creates a restricted onboarding grant cookie for an unlinked Google account (nextStep create_shop)', async () => {
      const res = await webGoogle(g('unlinked@gmail.test'));
      expect(res.statusCode, res.body).toBe(200);
      const cookie = res.cookies.find((c) => c.name === 'printout_onboarding');
      expect(cookie).toBeTruthy();
      expect(cookie?.httpOnly).toBe(true);
      expect(res.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
      const d = data(res);
      expect(d.nextStep).toBe('create_shop');
      expect(d.user.id).toBeNull();
      expect(d.user.role).toBeNull();
      expect(d.user.email).toBe('unlinked@gmail.test');
      expect(d.user.loginMethods).toContain('google');
      expect(d.onboarding).toMatchObject({ transport: 'cookie' });
      expect(d.shops).toEqual([]);
      expect(d.shop).toBeNull();
      expect(d.isShopRegisteredAtLeastOne).toBe(false);
    });

    it('allows web Google onboarding via POST /shops/onboarding: creates shop, user without password, links Google, and returns full session', async () => {
      const gRes = await webGoogle(g('web_owner@gmail.test'));
      expect(gRes.statusCode).toBe(200);
      const grantCookie = gRes.cookies.find((c) => c.name === 'printout_onboarding')!;

      const onboardRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/shops/onboarding',
        payload: { ownerName: 'Web Owner', shopName: 'Web Shop Prints', address: '42 MG Road, Bangalore', pincode: '560001', client: 'web' },
        headers: { origin: 'http://localhost:5173', cookie: `printout_onboarding=${grantCookie.value}` }
      });
      expect([200, 201], onboardRes.body).toContain(onboardRes.statusCode);

      const sessionCookie = onboardRes.cookies.find((c) => c.name === 'printout_session');
      expect(sessionCookie).toBeTruthy();
      expect(sessionCookie?.httpOnly).toBe(true);

      const d = data(onboardRes);
      expect(d.csrfToken).toBeTruthy();
      expect(d.user.role).toBe('shop');
      expect(d.user.email).toBe('web_owner@gmail.test');
      expect(d.shop.shopName).toBe('Web Shop Prints');

      const user = await h.prisma.user.findUniqueOrThrow({ where: { email: 'web_owner@gmail.test' }, include: { shop: true } });
      expect(user.displayName).toBe('Web Owner');
      expect(user.passwordSet).toBe(false);
      expect(user.shop?.displayName).toBe('Web Shop Prints');
      expect(user.shop?.status).toBe('ACTIVE');
      expect(user.shop?.acceptsOrders).toBe(true);
      const identity = await h.prisma.userGoogleIdentity.findUnique({ where: { userId: user.id } });
      expect(identity).toBeTruthy();
      expect(identity?.firebaseUid).toBe('guid-web_owner@gmail.test');

      // Subsequent Google login for this account logs in directly as the shop owner
      const nextLogin = await webGoogle(g('web_owner@gmail.test'));
      expect(nextLogin.statusCode).toBe(200);
      expect(data(nextLogin).user.id).toBe(user.id);
      expect(data(nextLogin).shop?.id).toBe(user.shopId);
    });

    it('refuses web onboarding when Google email collides with an existing account (409 EMAIL_UNAVAILABLE)', async () => {
      const gRes = await webGoogle(g(h.world.b.ownerEmail));
      expect(gRes.statusCode).toBe(200);
      const grantCookie = gRes.cookies.find((c) => c.name === 'printout_onboarding')!;

      const onboardRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/shops/onboarding',
        payload: { ownerName: 'Colliding Owner', shopName: 'Colliding Shop', address: '42 MG Road', pincode: '560001', client: 'web' },
        headers: { origin: 'http://localhost:5173', cookie: `printout_onboarding=${grantCookie.value}` }
      });
      expect(onboardRes.statusCode).toBe(409);
      expect(onboardRes.json().error.code).toBe('EMAIL_UNAVAILABLE');
    });

    it('restricted onboarding session cannot access protected shop endpoints', async () => {
      const gRes = await webGoogle(g('restricted_web@gmail.test'));
      const grantCookie = gRes.cookies.find((c) => c.name === 'printout_onboarding')!;
      const headers = { cookie: `printout_onboarding=${grantCookie.value}` };

      const me = await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers });
      expect(me.statusCode).toBe(200);
      expect(data(me).nextStep).toBe('create_shop');

      for (const path of ['/api/v1/shop/orders', '/api/v1/shops/me', '/api/v1/shop/settings', '/api/v1/admin/shops']) {
        const blocked = await h.app.inject({ method: 'GET', url: path, headers });
        expect([401, 403, 404], path).toContain(blocked.statusCode);
      }
    });

    it('logout with onboarding grant terminates the grant and clears the cookie', async () => {
      const gRes = await webGoogle(g('logout_web@gmail.test'));
      const grantCookie = gRes.cookies.find((c) => c.name === 'printout_onboarding')!;
      const headers = { cookie: `printout_onboarding=${grantCookie.value}` };

      const logoutRes = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers });
      expect(logoutRes.statusCode).toBe(204);

      const me = await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers });
      expect(me.statusCode).toBe(401);
    });

    it('refuses replay of the same token with 401 GOOGLE_TOKEN_INVALID', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      const t = g(OWNER_G);
      expect((await webGoogle(t)).statusCode).toBe(200);
      const replayed = await webGoogle(t);
      expect(replayed.statusCode).toBe(401);
      expect(replayed.json().error.code).toBe('GOOGLE_TOKEN_INVALID');
    });

    it('refuses cross-origin requests with 403 FORBIDDEN', async () => {
      await linkGoogleDirect(await ownerId(), OWNER_G);
      const res = await webGoogle(g(OWNER_G), { origin: 'https://evil.com' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });
  });
});

