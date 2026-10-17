import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import argon2 from 'argon2';
import { hashPassword, isWrappedHash, unwrapHash, verifyPassword } from '../src/auth.js';
import { buildKeyring, openSecret } from '../src/two-factor/crypto.js';
import { base32Decode, hotp, timeStep, totpAt } from '../src/two-factor/totp.js';
import { buildApp, call, login, PASSWORD, seedWorld, testConfig, type Session, type World } from './api-helpers.js';

const NEW_PASSWORD = 'a-brand-new-long-passphrase-42';
const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const STEP_MS = 30_000;
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

const setNow = (ms: number) => vi.setSystemTime(ms);
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

interface Enrolled {
  secret: Buffer;
  recoveryCodes: string[];
}

/** Everything below runs against a frozen-by-us clock (only Date is faked, so I/O and argon2 are unaffected). */
describe('admin two-factor authentication', () => {
  const ctx = buildApp({ TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS: '5' });
  let world: World;
  beforeAll(async () => {
    await ctx.app.ready();
  });
  afterAll(async () => ctx.app.close());
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setNow(T0);
    world = await seedWorld(ctx.prisma);
  });
  afterEach(() => vi.useRealTimers());

  const adminUser = (email = world.adminEmail) => ctx.prisma.user.findUniqueOrThrow({ where: { email } });
  const sessions = async (userId: string) => ctx.prisma.session.count({ where: { userId, invalidatedAt: null } });
  const row = async (userId: string) => ctx.prisma.adminTwoFactor.findUnique({ where: { userId } });
  const code = (secret: Buffer, offsetSteps = 0) => hotp(secret, timeStep(Date.now()) + offsetSteps);

  /** Enrolls the admin through the real API. Leaves the clock one step later so the enrollment code is not "replayed". */
  async function enroll(app: FastifyInstance, session: Session, password = PASSWORD): Promise<Enrolled> {
    const start = await call(app, session, 'POST', '/admin/account/2fa/enroll', { currentPassword: password });
    expect(start.statusCode, start.body).toBe(200);
    const secret = base32Decode(start.json().data.manualKey);
    const done = await call(app, session, 'POST', '/admin/account/2fa/enroll/verify', { code: totpAt(secret, Date.now()) });
    expect(done.statusCode, done.body).toBe(200);
    advance(STEP_MS);
    return { secret, recoveryCodes: done.json().data.recoveryCodes };
  }

  const passwordStep = (app: FastifyInstance, email: string, password = PASSWORD, cookie?: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, ...(cookie ? { headers: { cookie } } : {}) });
  const challengeCookie = (res: { cookies: Array<{ name: string; value: string }> }) => {
    const c = res.cookies.find((x) => x.name === 'printout_2fa');
    return c ? `printout_2fa=${c.value}` : undefined;
  };
  const secondStep = (app: FastifyInstance, cookie: string | undefined, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: payload as object, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const sessionFrom = (res: { cookies: Array<{ name: string; value: string }>; json: () => { data: { csrfToken: string; user: { id: string } } } }): Session => {
    const c = res.cookies.find((x) => x.name === 'printout_session');
    if (!c) throw new Error('no session cookie');
    return { cookie: `printout_session=${c.value}`, csrf: res.json().data.csrfToken, userId: res.json().data.user.id };
  };

  /** Full two-step sign-in with a TOTP code for the current step. */
  async function fullLogin(app: FastifyInstance, secret: Buffer, email = world.adminEmail) {
    const pw = await passwordStep(app, email);
    expect(pw.statusCode, pw.body).toBe(200);
    const done = await secondStep(app, challengeCookie(pw), { method: 'totp', code: code(secret) });
    expect(done.statusCode, done.body).toBe(200);
    return sessionFrom(done as never);
  }

  describe('enrollment lifecycle', () => {
    it('reports status, enrolls only after a valid code, and issues recovery codes once', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const before = await call(ctx.app, admin, 'GET', '/admin/account/2fa');
      expect(before.statusCode).toBe(200);
      expect(before.headers['cache-control']).toBe('no-store');
      expect(before.json().data).toEqual({ available: true, enabled: false, enrolledAt: null, recoveryCodesRemaining: 0, recoveryCodesAcknowledged: false, enrollmentPending: false });

      const start = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD });
      expect(start.statusCode).toBe(200);
      expect(start.headers['cache-control']).toBe('no-store');
      const data = start.json().data;
      expect(data.otpauthUri).toMatch(/^otpauth:\/\/totp\/Printout%20Buddy:admin%40x\.test\?secret=[A-Z2-7]{32}&issuer=Printout%20Buddy&algorithm=SHA1&digits=6&period=30$/);
      const secret = base32Decode(data.manualKey);
      expect(data.otpauthUri).toContain(`secret=${data.manualKey.replace(/ /g, '')}`);
      expect(secret.length).toBe(20);

      // Pending: NOT enabled, so sign-in is unchanged.
      let state = (await call(ctx.app, admin, 'GET', '/admin/account/2fa')).json().data;
      expect(state).toMatchObject({ enabled: false, enrollmentPending: true });
      expect((await row((await adminUser()).id))?.enabledAt).toBeNull();
      const plain = await passwordStep(ctx.app, world.adminEmail);
      expect(plain.json().data.user.role).toBe('PLATFORM_ADMIN');

      // A wrong code does not enable it.
      const wrong = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll/verify', { code: code(secret, 5) });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error.code).toBe('INVALID_TWO_FACTOR_CODE');
      expect((await row((await adminUser()).id))?.enabledAt).toBeNull();

      const other = await login(ctx.app, world.adminEmail); // a second device, signed in before enabling
      const ok = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll/verify', { code: totpAt(secret, Date.now()) });
      expect(ok.statusCode).toBe(200);
      const { recoveryCodes, enabledAt } = ok.json().data;
      expect(new Set(recoveryCodes).size).toBe(10);
      for (const c of recoveryCodes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
      expect(new Date(enabledAt).getTime()).toBe(T0);

      state = (await call(ctx.app, admin, 'GET', '/admin/account/2fa')).json().data;
      expect(state).toEqual({ available: true, enabled: true, enrolledAt: new Date(T0).toISOString(), recoveryCodesRemaining: 10, recoveryCodesAcknowledged: false, enrollmentPending: false });
      // Enabling ends the OTHER sessions and keeps the current one.
      expect((await call(ctx.app, admin, 'GET', '/admin/account')).statusCode).toBe(200);
      expect((await call(ctx.app, other, 'GET', '/admin/account')).statusCode).toBe(401);

      const ack = await call(ctx.app, admin, 'POST', '/admin/account/2fa/recovery-codes/acknowledge', {});
      expect(ack.statusCode).toBe(204);
      expect((await call(ctx.app, admin, 'GET', '/admin/account/2fa')).json().data.recoveryCodesAcknowledged).toBe(true);
    });

    it('requires the current password, admin role and CSRF; refuses a second enrollment', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const owner = await login(ctx.app, world.a.ownerEmail);
      const bad = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: 'not-my-password-1' });
      expect(bad.statusCode).toBe(403);
      expect(bad.json().error.code).toBe('INVALID_CURRENT_PASSWORD');
      expect(await row(admin.userId)).toBeNull();
      expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.account.reauth_failed', metadata: { path: ['operation'], equals: '2fa_enroll' } } })).toBe(1);

      expect((await call(ctx.app, null, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD })).statusCode).toBe(401);
      expect((await call(ctx.app, owner, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD })).statusCode).toBe(403);
      expect((await call(ctx.app, owner, 'GET', '/admin/account/2fa')).statusCode).toBe(403);
      expect((await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD, extra: 1 })).statusCode).toBe(400);

      await enroll(ctx.app, admin);
      const again = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('TWO_FACTOR_ALREADY_ENABLED');
    });

    it('restarting enrollment replaces the pending secret; an expired or absent enrollment cannot be confirmed', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      expect((await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll/verify', { code: '123456' })).json().error.code).toBe('NO_PENDING_ENROLLMENT');
      const first = base32Decode((await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD })).json().data.manualKey);
      const second = base32Decode((await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD })).json().data.manualKey);
      expect(first.equals(second)).toBe(false);
      expect(await ctx.prisma.adminTwoFactor.count()).toBe(1);
      // The first secret is dead.
      expect((await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll/verify', { code: totpAt(first, Date.now()) })).statusCode).toBe(403);
      advance(16 * 60_000);
      const late = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll/verify', { code: totpAt(second, Date.now()) });
      expect(late.statusCode).toBe(409);
      expect(await row(admin.userId)).toBeNull();
    });

    it('does not enable 2FA when the recovery-code batch cannot be stored (all-or-nothing)', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const secret = base32Decode((await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD })).json().data.manualKey);
      await ctx.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_codes() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'nope'; END $$ LANGUAGE plpgsql`);
      await ctx.prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_codes BEFORE INSERT ON "AdminRecoveryCode" FOR EACH ROW EXECUTE FUNCTION test_fail_codes()`);
      try {
        const res = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll/verify', { code: totpAt(secret, Date.now()) });
        expect(res.statusCode).toBe(500);
      } finally {
        await ctx.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_codes ON "AdminRecoveryCode"`);
        await ctx.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_codes()`);
      }
      expect((await row(admin.userId))?.enabledAt).toBeNull();
      expect((await passwordStep(ctx.app, world.adminEmail)).json().data.twoFactorRequired).toBeUndefined();
    });
  });

  describe('secrets at rest', () => {
    it('stores the TOTP secret as AES-GCM ciphertext bound to the user, and recovery codes only as Argon2id hashes', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret, recoveryCodes } = await enroll(ctx.app, admin);
      const stored = (await row(admin.userId))!;
      const ring = buildKeyring(TEST_KEY);
      expect(stored.secretEnc.startsWith(`v1.${ring.primary.id}.`)).toBe(true);
      expect(stored.keyId).toBe(ring.primary.id);
      for (const needle of [secret.toString('hex'), secret.toString('base64'), secret.toString('base64url')]) expect(stored.secretEnc).not.toContain(needle);
      expect(openSecret(ring, admin.userId, stored.secretEnc).equals(secret)).toBe(true);
      expect(() => openSecret(ring, 'someone-else', stored.secretEnc)).toThrow();

      const codes = await ctx.prisma.adminRecoveryCode.findMany({ where: { userId: admin.userId } });
      expect(codes).toHaveLength(10);
      for (const c of codes) expect(c.codeHash).toMatch(/^\$argon2id\$/);
      const dump = JSON.stringify([stored, codes, await ctx.prisma.session.findMany(), await ctx.prisma.adminLoginChallenge.findMany()], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      for (const plain of recoveryCodes) expect(dump).not.toContain(plain.replace('-', ''));
      expect(dump).not.toContain(secret.toString('hex'));
    });

    it('fails closed when a stored secret was tampered with', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const stored = (await row(admin.userId))!;
      const parts = stored.secretEnc.split('.');
      parts[3] = Buffer.alloc(20, 1).toString('base64url');
      await ctx.prisma.adminTwoFactor.update({ where: { userId: admin.userId }, data: { secretEnc: parts.join('.') } });
      const pw = await passwordStep(ctx.app, world.adminEmail);
      const res = await secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: code(secret) });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('TWO_FACTOR_UNAVAILABLE');
      expect(res.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
    });

    it('is unavailable without an encryption key and never silently skips the check for enrolled admins', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const keyless = createApp({ config: testConfig({ TWO_FACTOR_ENCRYPTION_KEY: '' }), prisma: ctx.prisma }).app;
      await keyless.ready();
      try {
        const login1 = await passwordStep(keyless, world.adminEmail);
        expect(login1.statusCode).toBe(503);
        expect(login1.json().error.code).toBe('TWO_FACTOR_UNAVAILABLE');
        expect(login1.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
        expect(login1.cookies.find((c) => c.name === 'printout_2fa')).toBeUndefined();
        expect(secret.length).toBe(20);
        // Non-enrolled accounts are untouched, and the status says why enrollment is off.
        const owner = await login(keyless, world.a.ownerEmail);
        expect((await call(keyless, owner, 'GET', '/shop/orders')).statusCode).toBe(200);
        await ctx.prisma.adminTwoFactor.deleteMany();
        const plainAdmin = await login(keyless, world.adminEmail);
        expect((await call(keyless, plainAdmin, 'GET', '/admin/account/2fa')).json().data.available).toBe(false);
        const enrollRes = await call(keyless, plainAdmin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD });
        expect(enrollRes.statusCode).toBe(503);
      } finally {
        await keyless.close();
      }
    });
  });

  describe('admin login challenge', () => {
    it('leaves accounts without 2FA completely unchanged (admin and shop owner)', async () => {
      const admin = await passwordStep(ctx.app, world.adminEmail);
      expect(admin.statusCode).toBe(200);
      expect(admin.json().data).toMatchObject({ user: { role: 'PLATFORM_ADMIN' } });
      expect(admin.cookies.find((c) => c.name === 'printout_session')).toBeDefined();
      expect(admin.cookies.find((c) => c.name === 'printout_2fa')).toBeUndefined();
      const owner = await passwordStep(ctx.app, world.a.ownerEmail);
      expect(owner.json().data.user.role).toBe('SHOP_OWNER');
    });

    it('issues only a restricted pending challenge after the password, and a full session only after the second factor', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const sessionsBefore = await ctx.prisma.session.count();

      const pw = await passwordStep(ctx.app, world.adminEmail);
      expect(pw.statusCode).toBe(200);
      expect(pw.headers['cache-control']).toBe('no-store');
      expect(pw.json().data).toEqual({ twoFactorRequired: true, expiresInSeconds: 300 });
      expect(pw.body).not.toMatch(/csrf|"user"|"shop"/i);
      expect(pw.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
      const cookie = pw.cookies.find((c) => c.name === 'printout_2fa')!;
      expect(cookie).toMatchObject({ httpOnly: true, path: '/api/v1/auth/login/2fa', sameSite: 'Lax' });
      expect(await ctx.prisma.session.count()).toBe(sessionsBefore); // no session of any kind exists yet

      // The pending token stores only a hash, and is useless as a session in every position.
      const stored = await ctx.prisma.adminLoginChallenge.findMany();
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(cookie.value);
      for (const name of ['printout_session', 'printout_2fa']) {
        for (const url of ['/admin/account', '/admin/dashboard', '/admin/shops', '/admin/account/2fa', '/auth/session']) {
          const res = await ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie: `${name}=${cookie.value}` } });
          expect(res.statusCode, `${name} ${url}`).toBe(401);
        }
        const mutate = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/account/2fa/enroll', headers: { cookie: `${name}=${cookie.value}`, 'x-csrf-token': 'x' }, payload: { currentPassword: PASSWORD } });
        expect(mutate.statusCode).toBe(401);
      }

      const done = await secondStep(ctx.app, `printout_2fa=${cookie.value}`, { method: 'totp', code: code(secret) });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().data.user).toMatchObject({ role: 'PLATFORM_ADMIN' });
      expect(done.cookies.find((c) => c.name === 'printout_2fa')).toMatchObject({ value: '' }); // challenge cookie cleared
      const session = sessionFrom(done as never);
      expect((await call(ctx.app, session, 'GET', '/admin/account')).statusCode).toBe(200);
      expect((await ctx.prisma.auditLog.findMany({ where: { action: 'auth.login', actorUserId: admin.userId }, orderBy: { createdAt: 'asc' } })).at(-1)?.metadata).toEqual({ secondFactor: 'totp' });
    });

    it('never confuses challenges: wrong password, no cookie, garbage cookie, other users, replaced challenge', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      expect((await passwordStep(ctx.app, world.adminEmail, 'wrong-password-123')).statusCode).toBe(401);
      expect((await secondStep(ctx.app, undefined, { method: 'totp', code: code(secret) })).json().error.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
      expect((await secondStep(ctx.app, 'printout_2fa=garbage', { method: 'totp', code: code(secret) })).statusCode).toBe(401);
      expect((await secondStep(ctx.app, `printout_2fa=${'x'.repeat(300)}`, { method: 'totp', code: code(secret) })).statusCode).toBe(401);

      // Same browser re-enters the password: the earlier challenge in THAT browser is replaced and dies.
      const first = await passwordStep(ctx.app, world.adminEmail);
      const second = await passwordStep(ctx.app, world.adminEmail, PASSWORD, challengeCookie(first));
      expect((await secondStep(ctx.app, challengeCookie(first), { method: 'totp', code: code(secret) })).statusCode).toBe(401);
      expect((await secondStep(ctx.app, challengeCookie(second), { method: 'totp', code: code(secret) })).statusCode).toBe(200);
    });

    it('keeps two devices independent: each has its own challenge, and one device finishing does not disturb the other', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const laptop = await passwordStep(ctx.app, world.adminEmail);
      const phone = await passwordStep(ctx.app, world.adminEmail);
      expect(challengeCookie(laptop)).not.toBe(challengeCookie(phone));
      expect((await secondStep(ctx.app, challengeCookie(laptop), { method: 'totp', code: code(secret) })).statusCode).toBe(200);
      advance(STEP_MS);
      expect((await secondStep(ctx.app, challengeCookie(phone), { method: 'totp', code: code(secret) })).statusCode).toBe(200);
    });

    it("rejects another admin's code and another admin's challenge", async () => {
      const a = await login(ctx.app, world.adminEmail);
      const secretA = (await enroll(ctx.app, a)).secret;
      await ctx.prisma.user.create({ data: { email: 'admin2@x.test', displayName: 'Admin Two', passwordHash: await hashPassword(PASSWORD), role: 'PLATFORM_ADMIN' } });
      const b = await login(ctx.app, 'admin2@x.test');
      const secretB = (await enroll(ctx.app, b)).secret;
      const challengeB = await passwordStep(ctx.app, 'admin2@x.test');
      expect((await secondStep(ctx.app, challengeCookie(challengeB), { method: 'totp', code: code(secretA) })).statusCode).toBe(401);
      expect((await secondStep(ctx.app, challengeCookie(challengeB), { method: 'totp', code: code(secretB) })).statusCode).toBe(200);
    });

    it('only platform admins are ever challenged', async () => {
      const ownerId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: world.a.ownerEmail } })).id;
      await ctx.prisma.adminTwoFactor.create({ data: { userId: ownerId, secretEnc: 'v1.x.y.z.w', keyId: 'x', enabledAt: new Date() } });
      const res = await passwordStep(ctx.app, world.a.ownerEmail);
      expect(res.json().data.user.role).toBe('SHOP_OWNER');
      expect(res.cookies.find((c) => c.name === 'printout_2fa')).toBeUndefined();
    });

    it('requires a CSRF token on every management mutation (and 401 without a session)', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      await enroll(ctx.app, admin);
      const noCsrf = { ...admin, csrf: 'forged' };
      const urls: Array<[string, unknown]> = [
        ['/admin/account/2fa/enroll', { currentPassword: PASSWORD }],
        ['/admin/account/2fa/enroll/verify', { code: '123456' }],
        ['/admin/account/2fa/recovery-codes', { currentPassword: PASSWORD, code: '123456' }],
        ['/admin/account/2fa/recovery-codes/acknowledge', {}],
        ['/admin/account/2fa/disable', { currentPassword: PASSWORD, method: 'totp', code: '123456' }]
      ];
      for (const [url, body] of urls) {
        const res = await call(ctx.app, noCsrf, 'POST', url, body);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error.code, url).toBe('CSRF_INVALID');
      }
      expect((await call(ctx.app, admin, 'GET', '/admin/account/2fa')).json().data.enabled).toBe(true);
    });
  });

  describe('codes: validity, expiry and replay', () => {
    it('refuses an invalid code and does not issue a session', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const pw = await passwordStep(ctx.app, world.adminEmail);
      const bad = code(secret) === '000000' ? '111111' : '000000';
      for (const payload of [{ method: 'totp', code: bad }, { method: 'totp', code: 'abcdef' }, { method: 'totp', code: '12345' }, { method: 'recovery', code: 'ABCDE-FGHJK' }]) {
        const res = await secondStep(ctx.app, challengeCookie(pw), payload);
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('INVALID_TWO_FACTOR_CODE');
        expect(res.cookies.find((c) => c.name === 'printout_session')).toBeUndefined();
      }
      expect((await secondStep(ctx.app, challengeCookie(pw), { method: 'sms', code: '1' })).statusCode).toBe(400);
      expect((await secondStep(ctx.app, challengeCookie(pw), { method: 'totp' })).statusCode).toBe(400);
    });

    it('enforces the +-1 step skew window at its boundaries', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin); // clock is now enrollmentStep + 1
      const reset = () => ctx.prisma.adminTwoFactor.update({ where: { userId: admin.userId }, data: { lastUsedStep: 0n } });
      const attempt = async (offset: number) => {
        await reset();
        const pw = await passwordStep(ctx.app, world.adminEmail);
        return secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: code(secret, offset) });
      };
      expect((await attempt(-2)).statusCode).toBe(401); // expired
      expect((await attempt(2)).statusCode).toBe(401); // not yet valid
      expect((await attempt(-1)).statusCode).toBe(200); // previous step: accepted (clock skew)
      expect((await attempt(1)).statusCode).toBe(200); // next step: accepted (clock skew)
      expect((await attempt(0)).statusCode).toBe(200);
    });

    it('treats a code as consumed: it cannot authorise a second sign-in, but the next step\'s code works', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const used = code(secret);
      const one = await passwordStep(ctx.app, world.adminEmail);
      expect((await secondStep(ctx.app, challengeCookie(one), { method: 'totp', code: used })).statusCode).toBe(200);
      const two = await passwordStep(ctx.app, world.adminEmail);
      const replay = await secondStep(ctx.app, challengeCookie(two), { method: 'totp', code: used });
      expect(replay.statusCode).toBe(401);
      expect((await ctx.prisma.auditLog.findMany({ where: { action: 'auth.2fa.failed' } })).map((a) => a.metadata)).toContainEqual({ method: 'totp', reason: 'replay' });
      // An older code than the last accepted one is also dead (no going backwards inside the window).
      expect((await secondStep(ctx.app, challengeCookie(two), { method: 'totp', code: code(secret, -1) })).statusCode).toBe(401);
      advance(STEP_MS);
      expect((await secondStep(ctx.app, challengeCookie(two), { method: 'totp', code: code(secret) })).statusCode).toBe(200);
    });

    it('lets exactly one of many concurrent challenges win with the same code', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const challenges = await Promise.all(Array.from({ length: 6 }, () => passwordStep(ctx.app, world.adminEmail)));
      const c = code(secret);
      const results = await Promise.all(challenges.map((pw) => secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: c })));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 401)).toHaveLength(5);
    });

    it('lets exactly one of many concurrent requests on the SAME challenge win', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const pw = await passwordStep(ctx.app, world.adminEmail);
      const before = await ctx.prisma.session.count();
      const results = await Promise.all(Array.from({ length: 5 }, () => secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: code(secret) })));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(await ctx.prisma.session.count()).toBe(before + 1);
    });

    it('expires the pending challenge', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const pw = await passwordStep(ctx.app, world.adminEmail);
      advance(299_000);
      expect((await secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: 'abcdef' })).statusCode).toBe(401); // still alive: code wrong
      advance(2_000);
      const late = await secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: code(secret) });
      expect(late.statusCode).toBe(401);
      expect(late.json().error.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    });

    it('cancel abandons the pending challenge', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const pw = await passwordStep(ctx.app, world.adminEmail);
      const cancel = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa/cancel', headers: { cookie: challengeCookie(pw)! } });
      expect(cancel.statusCode).toBe(204);
      expect((await secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: code(secret) })).statusCode).toBe(401);
    });
  });

  describe('brute-force protection', () => {
    it('destroys a challenge after the per-challenge attempt budget, even for a later correct code', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const pw = await passwordStep(ctx.app, world.adminEmail);
      for (let i = 0; i < 5; i++) expect((await secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: '999999' === code(secret) ? '888888' : '999999' })).statusCode).toBe(401);
      const last = await secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: code(secret) });
      expect(last.statusCode).toBe(401);
      expect(last.json().error.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
      expect((await ctx.prisma.adminLoginChallenge.findMany()).map((c) => c.attempts)).toEqual([5]); // spent, not usable
    });

    it('cannot overshoot the budget with parallel guesses', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const pw = await passwordStep(ctx.app, world.adminEmail);
      const wrong = code(secret) === '123456' ? '654321' : '123456';
      await Promise.all(Array.from({ length: 12 }, () => secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: wrong })));
      const audits = await ctx.prisma.auditLog.count({ where: { action: 'auth.2fa.failed' } });
      expect(audits).toBeLessThanOrEqual(5);
    });

    it('throttles per admin account across challenges and reports 429', async () => {
      const strict = buildApp({ LOGIN_FAIL_MAX: '3', TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS: '3' });
      await strict.app.ready();
      try {
        const admin = await login(strict.app, world.adminEmail);
        const { secret } = await enroll(strict.app, admin);
        const statuses: number[] = [];
        for (let round = 0; round < 3; round++) {
          const pw = await passwordStep(strict.app, world.adminEmail);
          for (let i = 0; i < 3; i++) statuses.push((await secondStep(strict.app, challengeCookie(pw), { method: 'totp', code: '000000' === code(secret) ? '111111' : '000000' })).statusCode);
        }
        // 2 x 3 wrong answers exhaust the budget of 6 (LOGIN_FAIL_MAX * 2); the third round is throttled.
        expect(statuses.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401]);
        expect(statuses.slice(6)).toEqual([429, 429, 429]);
        const pw = await passwordStep(strict.app, world.adminEmail);
        const blocked = await secondStep(strict.app, challengeCookie(pw), { method: 'totp', code: code(secret) });
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json().error.code).toBe('RATE_LIMITED');
      } finally {
        await strict.app.close();
      }
    });
  });

  describe('recovery codes', () => {
    it('signs in once per code, case/format-insensitively, and audits usage without the code', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { recoveryCodes } = await enroll(ctx.app, admin);
      const first = recoveryCodes[0]!;
      const pw = await passwordStep(ctx.app, world.adminEmail);
      const done = await secondStep(ctx.app, challengeCookie(pw), { method: 'recovery', code: ` ${first.toLowerCase().replace('-', ' ')} ` });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().data.recoveryCodesRemaining).toBe(9);

      const used = await ctx.prisma.auditLog.findMany({ where: { action: 'auth.2fa.recovery_code_used' } });
      expect(used).toHaveLength(1);
      expect(used[0]!.metadata).toEqual({ remaining: 9 });
      expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain(first.replace('-', ''));

      const again = await passwordStep(ctx.app, world.adminEmail);
      const reuse = await secondStep(ctx.app, challengeCookie(again), { method: 'recovery', code: first });
      expect(reuse.statusCode).toBe(401);
      expect((await secondStep(ctx.app, challengeCookie(again), { method: 'recovery', code: recoveryCodes[1]! })).statusCode).toBe(200);
    });

    it('consumes a recovery code at most once under concurrency', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { recoveryCodes } = await enroll(ctx.app, admin);
      const challenges = await Promise.all(Array.from({ length: 4 }, () => passwordStep(ctx.app, world.adminEmail)));
      const results = await Promise.all(challenges.map((pw) => secondStep(ctx.app, challengeCookie(pw), { method: 'recovery', code: recoveryCodes[3]! })));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(await ctx.prisma.adminRecoveryCode.count({ where: { userId: admin.userId, usedAt: { not: null } } })).toBe(1);
    });

    it('regenerates only after password + authenticator code, and invalidates every old code', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret, recoveryCodes: oldCodes } = await enroll(ctx.app, admin);
      const body = (over: object) => ({ currentPassword: PASSWORD, code: code(secret), ...over });
      const url = '/admin/account/2fa/recovery-codes';
      expect((await call(ctx.app, admin, 'POST', url, body({ currentPassword: 'wrong-wrong-wrong' }))).json().error.code).toBe('INVALID_CURRENT_PASSWORD');
      expect((await call(ctx.app, admin, 'POST', url, body({ code: code(secret, 4) }))).json().error.code).toBe('INVALID_TWO_FACTOR_CODE');
      expect((await call(ctx.app, admin, 'POST', url, { currentPassword: PASSWORD, method: 'recovery', code: oldCodes[0] })).statusCode).toBe(400);
      expect(await ctx.prisma.adminRecoveryCode.count({ where: { userId: admin.userId, usedAt: null } })).toBe(10);

      const ok = await call(ctx.app, admin, 'POST', url, body({}));
      expect(ok.statusCode, ok.body).toBe(200);
      const fresh: string[] = ok.json().data.recoveryCodes;
      expect(fresh).toHaveLength(10);
      expect(fresh.filter((c) => oldCodes.includes(c))).toHaveLength(0);
      expect(await ctx.prisma.adminRecoveryCode.count({ where: { userId: admin.userId } })).toBe(10);
      expect((await call(ctx.app, admin, 'GET', '/admin/account/2fa')).json().data.recoveryCodesAcknowledged).toBe(false);

      const pw = await passwordStep(ctx.app, world.adminEmail);
      expect((await secondStep(ctx.app, challengeCookie(pw), { method: 'recovery', code: oldCodes[0]! })).statusCode).toBe(401);
      expect((await secondStep(ctx.app, challengeCookie(pw), { method: 'recovery', code: fresh[0]! })).statusCode).toBe(200);
      // The same authenticator code cannot be replayed to regenerate again in the same step.
      expect((await call(ctx.app, admin, 'POST', url, body({}))).statusCode).toBe(403);
    });
  });

  describe('disabling', () => {
    it('needs password + a valid second factor, then removes everything and ends other sessions', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret, recoveryCodes } = await enroll(ctx.app, admin);
      const other = await fullLogin(ctx.app, secret);
      advance(STEP_MS);
      const pending = await passwordStep(ctx.app, world.adminEmail);
      const url = '/admin/account/2fa/disable';
      expect((await call(ctx.app, other, 'POST', url, { currentPassword: 'nope-nope-nope', method: 'totp', code: code(secret) })).statusCode).toBe(403);
      expect((await call(ctx.app, other, 'POST', url, { currentPassword: PASSWORD, method: 'totp', code: '000000' === code(secret) ? '111111' : '000000' })).json().error.code).toBe('INVALID_TWO_FACTOR_CODE');
      expect((await row(admin.userId))?.enabledAt).not.toBeNull();

      const ok = await call(ctx.app, other, 'POST', url, { currentPassword: PASSWORD, method: 'recovery', code: recoveryCodes[2]! });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await row(admin.userId)).toBeNull();
      expect(await ctx.prisma.adminRecoveryCode.count()).toBe(0);
      expect(await ctx.prisma.adminLoginChallenge.count()).toBe(0);
      expect((await call(ctx.app, other, 'GET', '/admin/account')).statusCode).toBe(200); // current session continues
      expect(await sessions(admin.userId)).toBe(1);
      expect((await secondStep(ctx.app, challengeCookie(pending), { method: 'totp', code: code(secret) })).statusCode).toBe(401);
      const plain = await passwordStep(ctx.app, world.adminEmail);
      expect(plain.json().data.user.role).toBe('PLATFORM_ADMIN');
      const log = await ctx.prisma.auditLog.findMany({ where: { action: 'admin.2fa.disabled' } });
      expect(log).toHaveLength(1);
      expect(log[0]!.metadata).toMatchObject({ method: 'recovery' });
    });
  });

  describe('interaction with password and email changes', () => {
    it('ends all sessions and pending challenges, keeps 2FA enabled, and the next sign-in still needs a code', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const pending = await passwordStep(ctx.app, world.adminEmail);
      const change = await call(ctx.app, admin, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(change.statusCode, change.body).toBe(200);
      expect(await sessions(admin.userId)).toBe(0);
      expect(await ctx.prisma.adminLoginChallenge.count()).toBe(0);
      expect((await secondStep(ctx.app, challengeCookie(pending), { method: 'totp', code: code(secret) })).statusCode).toBe(401);
      expect((await row(admin.userId))?.enabledAt).not.toBeNull();
      const pw = await passwordStep(ctx.app, world.adminEmail, NEW_PASSWORD);
      expect(pw.json().data.twoFactorRequired).toBe(true);
    });

    it('keeps 2FA after an email change and challenges the new email', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      expect((await call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: 'new-admin@x.test' })).statusCode).toBe(200);
      const pw = await passwordStep(ctx.app, 'new-admin@x.test');
      expect(pw.json().data.twoFactorRequired).toBe(true);
      expect((await secondStep(ctx.app, challengeCookie(pw), { method: 'totp', code: code(secret) })).statusCode).toBe(200);
    });

    it('voids a challenge whose credentials changed underneath it (fingerprint)', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret } = await enroll(ctx.app, admin);
      const pending = await passwordStep(ctx.app, world.adminEmail);
      await ctx.prisma.user.update({ where: { id: admin.userId }, data: { passwordHash: await hashPassword('operator-changed-this-77') } });
      expect((await secondStep(ctx.app, challengeCookie(pending), { method: 'totp', code: code(secret) })).statusCode).toBe(401);
    });
  });

  describe('rollback guard: an older API must fail closed for enrolled admins', () => {
    /** What every API version before two-factor does with the stored hash. */
    const oldApiAccepts = async (hash: string, password: string) => {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    };

    it('wraps the stored hash while 2FA is on, so password-only verification by old code fails; the new code still verifies', async () => {
      const before = (await adminUser()).passwordHash;
      expect(await oldApiAccepts(before, PASSWORD)).toBe(true); // before enrolling an old API accepts it
      const admin = await login(ctx.app, world.adminEmail);
      await enroll(ctx.app, admin);
      const enrolled = (await adminUser()).passwordHash;
      expect(isWrappedHash(enrolled)).toBe(true);
      expect(unwrapHash(enrolled)).toBe(before);
      expect(await oldApiAccepts(enrolled, PASSWORD)).toBe(false); // downgraded API: locked out, NOT password-only access
      expect(await verifyPassword(enrolled, PASSWORD)).toBe(true);
      // Other accounts are never wrapped.
      expect(isWrappedHash((await ctx.prisma.user.findUniqueOrThrow({ where: { email: world.a.ownerEmail } })).passwordHash)).toBe(false);
    });

    it('stays wrapped across a password change and is restored on disable', async () => {
      const admin = await login(ctx.app, world.adminEmail);
      const { secret, recoveryCodes } = await enroll(ctx.app, admin);
      const fresh = await fullLogin(ctx.app, secret);
      expect((await call(ctx.app, fresh, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).statusCode).toBe(200);
      const changed = (await adminUser()).passwordHash;
      expect(isWrappedHash(changed)).toBe(true);
      expect(await oldApiAccepts(changed, NEW_PASSWORD)).toBe(false);
      expect(await verifyPassword(changed, NEW_PASSWORD)).toBe(true);

      const pw = await passwordStep(ctx.app, world.adminEmail, NEW_PASSWORD);
      const session = sessionFrom((await secondStep(ctx.app, challengeCookie(pw), { method: 'recovery', code: recoveryCodes[0]! })) as never);
      const off = await call(ctx.app, session, 'POST', '/admin/account/2fa/disable', { currentPassword: NEW_PASSWORD, method: 'recovery', code: recoveryCodes[1]! });
      expect(off.statusCode, off.body).toBe(200);
      const restored = (await adminUser()).passwordHash;
      expect(isWrappedHash(restored)).toBe(false);
      expect(await oldApiAccepts(restored, NEW_PASSWORD)).toBe(true);
    });
  });

  describe('sensitive data never leaks', () => {
    it('keeps secrets, codes and tokens out of logs, audit metadata and error bodies', async () => {
      const lines: string[] = [];
      const app = createApp({
        config: testConfig({ NODE_ENV: 'development' }), // request logging is on (silent only under NODE_ENV=test)
        prisma: ctx.prisma,
        logStream: new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) })
      }).app;
      await app.ready();
      try {
        const admin = await login(app, world.adminEmail);
        const start = await call(app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD });
        const manualKey: string = start.json().data.manualKey;
        const secret = base32Decode(manualKey);
        const done = await call(app, admin, 'POST', '/admin/account/2fa/enroll/verify', { code: totpAt(secret, Date.now()) });
        const recoveryCodes: string[] = done.json().data.recoveryCodes;
        advance(STEP_MS);
        const wrongCode = '424242' === code(secret) ? '242424' : '424242';
        const pw = await passwordStep(app, world.adminEmail);
        const bad = await secondStep(app, challengeCookie(pw), { method: 'totp', code: wrongCode });
        const challengeToken = challengeCookie(pw)!.split('=')[1]!;
        const good = await secondStep(app, challengeCookie(pw), { method: 'recovery', code: recoveryCodes[0]! });
        const session = sessionFrom(good as never);
        await call(app, session, 'POST', '/admin/account/2fa/recovery-codes', { currentPassword: PASSWORD, code: wrongCode });

        const needles = [TEST_KEY, manualKey.replace(/ /g, ''), secret.toString('hex'), ...recoveryCodes, ...recoveryCodes.map((c) => c.replace('-', '')), challengeToken, session.cookie.split('=')[1]!, session.csrf, PASSWORD, wrongCode];
        const logs = lines.join('\n');
        const audits = JSON.stringify(await ctx.prisma.auditLog.findMany());
        expect(lines.length).toBeGreaterThan(0);
        for (const needle of needles) {
          expect(logs, 'logs').not.toContain(needle);
          expect(audits, 'audit').not.toContain(needle);
        }
        for (const body of [bad.body, pw.body]) {
          for (const needle of [manualKey.replace(/ /g, ''), wrongCode, PASSWORD]) expect(body).not.toContain(needle);
        }
        expect(audits).not.toMatch(/otpauth|secretEnc/);
      } finally {
        await app.close();
      }
    });
  });
});
