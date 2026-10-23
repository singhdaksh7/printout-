import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { mintEmulatorToken } from '../src/firebase/test-token.js';
import {
  FirebasePhoneVerifier,
  PhoneTokenInvalidError,
  PhoneVerifierUnavailableError,
  maskPhone,
  type AuthLike,
  type PhoneTokenVerifier
} from '../src/firebase/verifier.js';
import { call, login, PASSWORD, seedWorld, testConfig, type Session, type World } from './api-helpers.js';
import { testPrisma } from './helpers/db.js';
import { startFakeAuthEmulator } from './helpers/fake-auth-emulator.js';

// The real Admin SDK verifies these tokens in emulator mode (claims, audience, issuer, expiry; NOT signatures).
const emulator = await startFakeAuthEmulator();
process.env.FIREBASE_AUTH_EMULATOR_HOST = emulator.host;
const PROJECT = 'printout-test-project';
const PHONE_A = '+919876543210';
const PHONE_B = '+919123456780';
const PHONE_C = '+919555500001';
const now = () => Math.floor(Date.now() / 1000);

/** Token whose OTP was verified `ago` seconds ago (a later OTP = a smaller `ago`). */
const tok = (phone: string | null, ago = 5, extra: Partial<Parameters<typeof mintEmulatorToken>[0]> = {}) =>
  mintEmulatorToken({ projectId: PROJECT, uid: `uid-${phone ?? 'none'}`, phone, authTime: now() - ago, ...extra });

const ENV = { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_CHECK_REVOKED: 'false' };

function build(over: Record<string, string> = {}, phoneVerifier?: PhoneTokenVerifier | null) {
  const prisma = testPrisma();
  const built = createApp({ config: testConfig({ ...ENV, ...over }), prisma, ...(phoneVerifier !== undefined ? { phoneVerifier } : {}) });
  return { ...built, prisma };
}

const sessionFrom = (res: { cookies: Array<{ name: string; value: string }>; json(): { data: { csrfToken: string; user: { id: string } } } }): Session => {
  const c = res.cookies.find((x) => x.name === 'printout_session');
  if (!c) throw new Error('no session cookie');
  const d = res.json().data;
  return { cookie: `printout_session=${c.value}`, csrf: d.csrfToken, userId: d.user.id };
};

describe('Firebase phone sign-in (real Admin SDK, emulator-style tokens)', () => {
  const ctx = build();
  const app: FastifyInstance = ctx.app;
  let world: World;
  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await emulator.close();
  });
  beforeEach(async () => {
    emulator.disabled.clear();
    world = await seedWorld(ctx.prisma);
  });

  const phoneLogin = (idToken: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken }, headers });
  const link = (s: Session, idToken: string, currentPassword = PASSWORD) => call(app, s, 'POST', '/shop/account/phone', { idToken, currentPassword });
  const unlink = (s: Session, currentPassword = PASSWORD) => call(app, s, 'POST', '/shop/account/phone/unlink', { currentPassword });
  const ownerA = () => login(app, world.a.ownerEmail);
  async function linkedOwnerA(phone = PHONE_A) {
    const s = await ownerA();
    const res = await link(s, tok(phone, 60));
    expect(res.statusCode, res.body).toBe(200);
    return s;
  }

  it('config reports enabled with the allowed calling codes and no secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/phone/config' });
    expect(res.json().data).toEqual({ enabled: true, allowedCallingCodes: ['+91'], defaultCallingCode: '+91', resendCooldownSeconds: 30 });
    expect(res.body).not.toContain(PROJECT);
  });

  it('links a verified phone and then signs in with a fresh OTP, keeping role and shop', async () => {
    const s = await ownerA();
    const linked = await link(s, tok(PHONE_A, 60));
    expect(linked.json().data).toMatchObject({ linked: true, phoneMasked: maskPhone(PHONE_A), replaced: false, otherSessionsEnded: 0 });
    expect(linked.body).not.toContain(PHONE_A);
    const status = await call(app, s, 'GET', '/shop/account/phone');
    expect(status.json().data).toMatchObject({ linked: true, available: true, phoneMasked: maskPhone(PHONE_A) });

    const res = await phoneLogin(tok(PHONE_A, 10));
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.user.role).toBe('SHOP_OWNER');
    expect(data.shop.id).toBe(world.a.shopId);
    expect(data.csrfToken).toBeTruthy();
    expect(res.cookies.find((c) => c.name === 'printout_session')?.httpOnly).toBe(true);

    // The session is the normal one: it works on shop routes and logout ends it.
    const phoneSession = sessionFrom(res);
    expect((await call(app, phoneSession, 'GET', '/auth/session')).statusCode).toBe(200);
    expect((await call(app, phoneSession, 'POST', '/auth/logout')).statusCode).toBe(204);
    expect((await call(app, phoneSession, 'GET', '/auth/session')).statusCode).toBe(401);

    const actions = (await ctx.prisma.auditLog.findMany({ select: { action: true, metadata: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['shop.phone.linked', 'auth.phone.login']));
    expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain(PHONE_A);
  });

  it('refuses a verified phone that is not linked (no shop is created, nothing granted)', async () => {
    const shops = await ctx.prisma.shop.count();
    const res = await phoneLogin(tok(PHONE_C, 5));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PHONE_NOT_LINKED');
    expect(res.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
    expect(await ctx.prisma.shop.count()).toBe(shops);
  });

  describe('token verification', () => {
    beforeEach(async () => {
      await linkedOwnerA();
    });
    const cases: Array<[string, () => string]> = [
      ['wrong Firebase project (audience)', () => tok(PHONE_A, 5, { aud: 'someone-elses-project', iss: 'https://securetoken.google.com/someone-elses-project' })],
      ['wrong issuer', () => tok(PHONE_A, 5, { iss: 'https://evil.example/' + PROJECT })],
      ['expired token', () => tok(PHONE_A, 7200, { exp: now() - 3600 })],
      ['OTP verified too long ago', () => tok(PHONE_A, 3600)],
      ['not a phone sign-in', () => tok(PHONE_A, 5, { provider: 'password' })],
      ['no phone number', () => tok(null, 5)],
      ['calling code not allowed', () => tok('+14155550123', 5)],
      ['garbage', () => 'x'.repeat(40)],
      ['truncated JWT', () => tok(PHONE_A, 5).slice(0, 30)],
      ['unsigned token with the wrong header', () => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${tok(PHONE_A, 5).split('.')[1]}.sig`]
    ];
    it.each(cases)('rejects %s', async (_name, make) => {
      const res = await phoneLogin(make());
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe('PHONE_TOKEN_INVALID');
      expect(res.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
    });

    it('rejects a replayed token and a token not newer than the last accepted one', async () => {
      const token = tok(PHONE_A, 10);
      expect((await phoneLogin(token)).statusCode).toBe(200);
      const again = await phoneLogin(token);
      expect(again.statusCode).toBe(401);
      expect(again.json().error.code).toBe('PHONE_TOKEN_INVALID');
      expect((await phoneLogin(tok(PHONE_A, 20))).statusCode).toBe(401); // older OTP
      expect((await phoneLogin(tok(PHONE_A, 2))).statusCode).toBe(200); // newer OTP
    });

    it('the token used to link cannot be replayed to sign in', async () => {
      expect((await phoneLogin(tok(PHONE_A, 60))).statusCode).toBe(401);
    });

    it('does not accept the unsigned token body fields as identity: the phone must match a linked row', async () => {
      const res = await phoneLogin(tok(PHONE_C, 5, { uid: 'uid-attacker' }));
      expect(res.json().error.code).toBe('PHONE_NOT_LINKED');
    });

    it('rejects extra body fields and a missing token', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken: tok(PHONE_A, 3), userId: 'x' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: {} })).statusCode).toBe(400);
    });
  });

  it('requires re-verification after the link has been idle too long, and when the Firebase user changed', async () => {
    await linkedOwnerA();
    await ctx.prisma.userPhoneIdentity.updateMany({ data: { lastSignInAt: new Date(Date.now() - 91 * 86_400_000) } });
    const idle = await phoneLogin(tok(PHONE_A, 5));
    expect(idle.statusCode).toBe(403);
    expect(idle.json().error.code).toBe('PHONE_REVERIFY_REQUIRED');
    // password sign-in still works and a fresh link restores phone sign-in
    const s = await ownerA();
    expect((await link(s, tok(PHONE_A, 4))).statusCode).toBe(200);
    expect((await phoneLogin(tok(PHONE_A, 2))).statusCode).toBe(200);
    // recycled number: same phone, different Firebase UID
    const recycled = await phoneLogin(tok(PHONE_A, 1, { uid: 'a-different-firebase-user' }));
    expect(recycled.statusCode).toBe(403);
    expect(recycled.json().error.code).toBe('PHONE_REVERIFY_REQUIRED');
  });

  it('rejects a token whose Firebase user was disabled (revocation check goes through the SDK)', async () => {
    await linkedOwnerA();
    emulator.disabled.add(`uid-${PHONE_A}`);
    const res = await phoneLogin(tok(PHONE_A, 5));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('PHONE_TOKEN_INVALID');
  });

  it('blocks sign-in for a suspended shop', async () => {
    await linkedOwnerA();
    await ctx.prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    const res = await phoneLogin(tok(PHONE_A, 5));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SHOP_SUSPENDED');
  });

  describe('linking protections', () => {
    it('needs a signed-in shop owner, a CSRF token and the current password', async () => {
      const anon = await app.inject({ method: 'POST', url: '/api/v1/shop/account/phone', payload: { idToken: tok(PHONE_A, 5), currentPassword: PASSWORD } });
      expect(anon.statusCode).toBe(401);
      const s = await ownerA();
      const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/shop/account/phone', headers: { cookie: s.cookie }, payload: { idToken: tok(PHONE_A, 5), currentPassword: PASSWORD } });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.json().error.code).toBe('CSRF_INVALID');
      const wrong = await link(s, tok(PHONE_A, 5), 'not-the-password');
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error.code).toBe('INVALID_CURRENT_PASSWORD');
      expect(await ctx.prisma.userPhoneIdentity.count()).toBe(0);
      expect((await ctx.prisma.auditLog.findMany({ where: { action: 'shop.phone.reauth_failed' } })).length).toBe(1);
    });

    it('rejects an invalid or wrong-project token when linking', async () => {
      const s = await ownerA();
      const bad = await link(s, tok(PHONE_A, 5, { aud: 'other', iss: 'https://securetoken.google.com/other' }));
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe('PHONE_TOKEN_INVALID');
      expect(await ctx.prisma.userPhoneIdentity.count()).toBe(0);
    });

    it('refuses to link a phone that already belongs to another shop (no takeover), without naming whose', async () => {
      await linkedOwnerA();
      const b = await login(app, world.b.ownerEmail);
      const res = await link(b, tok(PHONE_A, 5));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PHONE_UNAVAILABLE');
      expect(res.body).not.toContain(world.a.shopId);
      // A's link is untouched and still signs A in
      const a = await phoneLogin(tok(PHONE_A, 2));
      expect(a.json().data.shop.id).toBe(world.a.shopId);
    });

    it('replaces the phone, ends other sessions, and the old phone stops working', async () => {
      const s = await linkedOwnerA(PHONE_A);
      const other = await ownerA(); // a second session of the same owner
      const res = await link(s, tok(PHONE_B, 30));
      expect(res.json().data).toMatchObject({ linked: true, replaced: true, otherSessionsEnded: 1 });
      expect((await call(app, other, 'GET', '/auth/session')).statusCode).toBe(401);
      expect((await call(app, s, 'GET', '/auth/session')).statusCode).toBe(200);
      expect((await phoneLogin(tok(PHONE_A, 3))).json().error.code).toBe('PHONE_NOT_LINKED');
      expect((await phoneLogin(tok(PHONE_B, 3))).statusCode).toBe(200);
      expect(await ctx.prisma.userPhoneIdentity.count()).toBe(1);
      expect((await ctx.prisma.auditLog.findMany({ where: { action: 'shop.phone.replaced' } })).length).toBe(1);
    });

    it('unlinks with the password, keeps the password login, ends other sessions and logs it', async () => {
      const s = await linkedOwnerA();
      const phoneSession = sessionFrom(await phoneLogin(tok(PHONE_A, 10)));
      expect((await unlink(s, 'wrong')).statusCode).toBe(403);
      const res = await unlink(s);
      expect(res.json().data).toMatchObject({ linked: false, otherSessionsEnded: 1 });
      expect((await call(app, phoneSession, 'GET', '/auth/session')).statusCode).toBe(401);
      expect((await phoneLogin(tok(PHONE_A, 1))).json().error.code).toBe('PHONE_NOT_LINKED');
      expect((await login(app, world.a.ownerEmail)).userId).toBeTruthy();
      expect((await unlink(s)).statusCode).toBe(404);
      expect((await ctx.prisma.auditLog.findMany({ where: { action: 'shop.phone.unlinked' } })).length).toBe(1);
    });

    it('re-linking the same phone with a used token is refused', async () => {
      const s = await ownerA();
      const t = tok(PHONE_A, 40);
      expect((await link(s, t)).statusCode).toBe(200);
      expect((await link(s, t)).statusCode).toBe(401);
    });

    it('platform admins can neither link nor sign in by phone', async () => {
      const admin = await login(app, world.adminEmail);
      const res = await link(admin, tok(PHONE_C, 5));
      expect(res.statusCode).toBe(403);
      expect(await ctx.prisma.userPhoneIdentity.count()).toBe(0);
      // even a forced row cannot sign an admin in
      const adminUser = await ctx.prisma.user.findUniqueOrThrow({ where: { email: world.adminEmail } });
      await ctx.prisma.userPhoneIdentity.create({ data: { userId: adminUser.id, firebaseUid: `uid-${PHONE_C}`, phoneE164: PHONE_C } });
      const forced = await phoneLogin(tok(PHONE_C, 5));
      expect(forced.statusCode).toBe(403);
      expect(forced.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
    });

    it('keeps shops isolated: a phone session only reaches its own shop', async () => {
      await linkedOwnerA();
      const phoneSession = sessionFrom(await phoneLogin(tok(PHONE_A, 10)));
      const orders = await call(app, phoneSession, 'GET', '/shop/orders');
      expect(orders.statusCode).toBe(200);
      const status = await call(app, phoneSession, 'GET', '/shop/account/phone');
      expect(status.json().data.linked).toBe(true);
      const b = await login(app, world.b.ownerEmail);
      expect((await call(app, b, 'GET', '/shop/account/phone')).json().data.linked).toBe(false);
    });
  });

  it('keeps email/password sign-in working and unaffected by a linked phone', async () => {
    await linkedOwnerA();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.shop.id).toBe(world.a.shopId);
  });

  it('rejects a request from another origin', async () => {
    const res = await phoneLogin(tok(PHONE_A, 5), { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    const ok = await phoneLogin(tok(PHONE_C, 5), { origin: 'http://localhost:5173' });
    expect(ok.json().error.code).toBe('PHONE_NOT_LINKED');
  });
});

describe('Firebase phone sign-in: availability, outages and throttling', () => {
  let world: World;
  beforeEach(async () => {
    world = await seedWorld(testPrisma());
  });

  it('is off (503) and advertised as disabled when no Firebase project is configured', async () => {
    const { app } = build({ FIREBASE_PROJECT_ID: '' });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/phone/config' })).json().data.enabled).toBe(false);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken: tok(PHONE_A, 5) } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('PHONE_LOGIN_UNAVAILABLE');
    const s = await login(app, world.a.ownerEmail);
    expect((await call(app, s, 'GET', '/shop/account/phone')).json().data).toEqual({ linked: false, available: false });
    expect((await call(app, s, 'POST', '/shop/account/phone', { idToken: tok(PHONE_A, 5), currentPassword: PASSWORD })).statusCode).toBe(503);
    await app.close();
  });

  it('answers 503 (not 401) when Firebase is unreachable, for sign-in and linking, and keeps password login', async () => {
    const down: PhoneTokenVerifier = {
      async verify() {
        throw new PhoneVerifierUnavailableError();
      },
      async revokeSessions() {}
    };
    const { app } = build({}, down);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken: 'a'.repeat(40) } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('PHONE_LOGIN_UNAVAILABLE');
    const s = await login(app, world.a.ownerEmail);
    expect((await call(app, s, 'POST', '/shop/account/phone', { idToken: 'a'.repeat(40), currentPassword: PASSWORD })).statusCode).toBe(503);
    // an outage does not count as a failed guess
    for (let i = 0; i < 10; i++) await app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken: 'a'.repeat(40) } });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken: 'a'.repeat(40) } })).statusCode).toBe(503);
    await app.close();
  });

  it('throttles repeated invalid tokens from one client (429) and rate-limits the route', async () => {
    const { app } = build({ LOGIN_FAIL_MAX: '3', LOGIN_RATE_LIMIT_MAX: '1000' });
    await app.ready();
    const bad = () => app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken: 'z'.repeat(40) } });
    expect([(await bad()).statusCode, (await bad()).statusCode, (await bad()).statusCode]).toEqual([401, 401, 401]);
    expect((await bad()).statusCode).toBe(429);
    await app.close();

    const limited = build({ LOGIN_RATE_LIMIT_MAX: '2' });
    await limited.app.ready();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await limited.app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken: tok(PHONE_C, 5) } })).statusCode);
    expect(codes.slice(2)).toEqual([429, 429]);
    await limited.app.close();
  });

  it('throttles repeated bad link tokens per account', async () => {
    const { app } = build({ LOGIN_FAIL_MAX: '3' });
    await app.ready();
    const s = await login(app, world.a.ownerEmail);
    const bad = () => call(app, s, 'POST', '/shop/account/phone', { idToken: 'z'.repeat(40), currentPassword: PASSWORD });
    for (let i = 0; i < 3; i++) expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(429);
    await app.close();
  });

  it('keeps its refusals out of the logs: no token, phone or password in logged request lines', async () => {
    const lines: string[] = [];
    const { Writable } = await import('node:stream');
    const logStream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const prisma = testPrisma();
    const { app } = createApp({ config: testConfig({ ...ENV }), prisma, logStream });
    await app.ready();
    const token = tok(PHONE_C, 5);
    await app.inject({ method: 'POST', url: '/api/v1/auth/phone/session', payload: { idToken: token } });
    await app.close();
    const all = lines.join('');
    expect(all).not.toContain(token);
    expect(all).not.toContain(PHONE_C);
  });
});

describe('FirebasePhoneVerifier (SDK wrapper)', () => {
  const claims = (over: Record<string, unknown> = {}) => ({
    aud: 'p',
    iss: 'https://securetoken.google.com/p',
    sub: 'u1',
    uid: 'u1',
    auth_time: now() - 5,
    exp: now() + 3000,
    phone_number: '+919876543210',
    firebase: { sign_in_provider: 'phone' },
    ...over
  });
  const make = (auth: Partial<AuthLike>) =>
    new FirebasePhoneVerifier(auth as AuthLike, { projectId: 'p', maxAgeSeconds: 300, checkRevoked: true, allowedCallingCodes: ['+91'] });
  const token = 'a'.repeat(40);

  it('returns the verified identity for a good token and asks the SDK to check revocation', async () => {
    let checked: boolean | undefined;
    const v = make({ verifyIdToken: async (_t, c) => ((checked = c), claims()) });
    expect(await v.verify(token)).toMatchObject({ uid: 'u1', phoneE164: '+919876543210' });
    expect(checked).toBe(true);
  });

  it.each([
    ['auth/id-token-expired'],
    ['auth/id-token-revoked'],
    ['auth/argument-error'],
    ['auth/user-disabled']
  ])('maps SDK error %s to an invalid token', async (code) => {
    const v = make({ verifyIdToken: async () => Promise.reject(Object.assign(new Error('x'), { code })) });
    await expect(v.verify(token)).rejects.toBeInstanceOf(PhoneTokenInvalidError);
  });

  it.each([['auth/internal-error'], ['app/network-error'], ['app/invalid-credential'], [undefined]])('fails closed as unavailable for %s', async (code) => {
    const v = make({ verifyIdToken: async () => Promise.reject(Object.assign(new Error('x'), { code })) });
    await expect(v.verify(token)).rejects.toBeInstanceOf(PhoneVerifierUnavailableError);
  });

  it('re-asserts project, provider, phone format, region and freshness even if the SDK passed it', async () => {
    const bad = [
      claims({ aud: 'other' }),
      claims({ iss: 'https://securetoken.google.com/other' }),
      claims({ firebase: { sign_in_provider: 'password' } }),
      claims({ phone_number: '9876543210' }),
      claims({ phone_number: '+14155550123' }),
      claims({ auth_time: now() - 4000 }),
      claims({ auth_time: now() + 4000 })
    ];
    for (const c of bad) await expect(make({ verifyIdToken: async () => c }).verify(token)).rejects.toBeInstanceOf(PhoneTokenInvalidError);
    await expect(make({ verifyIdToken: async () => claims() }).verify('short')).rejects.toBeInstanceOf(PhoneTokenInvalidError);
  });

  it('revokeSessions never throws', async () => {
    await expect(make({ revokeRefreshTokens: async () => Promise.reject(new Error('down')) }).revokeSessions('u1')).resolves.toBeUndefined();
  });

  it('maskPhone keeps only the calling code and last two digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91••••••••10');
  });
});

describe('configuration safety', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:s3cure-Pw-9f2k@db.internal:5432/app',
    SESSION_SECRET: 'prod-session-3f9a8c1d7e5b4a2c9d8e7f6a5b4c3d2e',
    CSRF_SECRET: 'prod-csrf-8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d',
    QUOTE_SECRET: 'prod-quote-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    STORAGE_URL_SECRET: 'prod-store-9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d',
    WEB_ORIGIN: 'https://printoutbuddy.tech',
    TRUST_PROXY: 'false',
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'true'
  };
  it('refuses the Firebase emulator in production and accepts a plain project id', () => {
    expect(() => loadConfig({ ...base, FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    const cfg = loadConfig({ ...base, FIREBASE_PROJECT_ID: 'printout-buddy-prod' } as NodeJS.ProcessEnv);
    expect(cfg.FIREBASE_PROJECT_ID).toBe('printout-buddy-prod');
    expect(cfg.PHONE_ALLOWED_CALLING_CODES).toEqual(['+91']);
    expect(cfg.FIREBASE_CHECK_REVOKED).toBe(true);
  });
  it('rejects malformed project ids and calling codes', () => {
    expect(() => loadConfig({ ...base, FIREBASE_PROJECT_ID: 'Bad Id!' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PHONE_ALLOWED_CALLING_CODES: '91' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
});
