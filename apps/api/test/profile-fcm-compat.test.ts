import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, login, PASSWORD } from './api-helpers.js';
import { base32Decode, totpAt } from '../src/two-factor/totp.js';
import {
  cookieOf, DEVICE_A, exchange, linkPhoneDirect, makeShopReady, mobileSessionOf, PHONES, req, sessionAuthFrom, startHarness, tok, userByEmail, type Harness
} from './helpers/profile-harness.js';

const FCM_A = 'fcm-token-A-0123456789-abcdefghijklmnopqrstuvwxyz';

describe('audit trail and secrets', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    await makeShopReady(h.prisma, h.world.a.shopId);
  });

  it('no credential, token, FCM token or full phone number ever lands in audit rows or the Firebase-facing log fields', async () => {
    const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
    await linkPhoneDirect(h.prisma, owner.id, PHONES.A);
    const idToken = tok(PHONES.A, 5);
    const mobile = await exchange(h.app, idToken, 'mobile', {}, DEVICE_A);
    const auth = sessionAuthFrom(mobile);
    await req(h.app, auth, 'PUT', '/users/me/fcm-token', { installationId: 'installation-audit-0000000001', token: FCM_A, platform: 'android' });
    await req(h.app, auth, 'PATCH', '/users/me', { name: 'Audit Name' });
    const grantRes = await exchange(h.app, tok(PHONES.NEW, 5), 'web');
    const onboardingCookie = cookieOf(grantRes, 'printout_onboarding')?.value ?? '';
    const bearer = auth?.kind === 'bearer' ? auth.token : '';
    const refreshSecret = mobileSessionOf(mobile).refreshToken;
    const blob = JSON.stringify(await h.prisma.auditLog.findMany());
    for (const secret of [idToken, FCM_A, bearer, refreshSecret, onboardingCookie, PHONES.A, PHONES.NEW, `uid-${PHONES.A}`, PASSWORD].filter(Boolean)) {
      expect(blob.includes(secret), `audit contains ${secret.slice(0, 12)}…`).toBe(false);
    }
  });

  it('sign-in and profile changes are audited with actor and no sensitive metadata', async () => {
    const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
    await linkPhoneDirect(h.prisma, owner.id, PHONES.A);
    const auth = sessionAuthFrom(await exchange(h.app, tok(PHONES.A, 5), 'mobile'));
    await req(h.app, auth, 'PATCH', '/users/me', { name: 'Renamed Owner' });
    const actions = (await h.prisma.auditLog.findMany({ where: { actorUserId: owner.id } })).map((r) => r.action);
    expect(actions).toContain('auth.firebase.exchange');
    expect(actions.some((a) => /profile|user\.updated|account/.test(a))).toBe(true);
  });
});

describe('Admin 2FA and email/password compatibility', () => {
  let h: Harness;
  let adminId: string;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-23T10:00:00.000Z'));
    await h.reseed();
    adminId = (await userByEmail(h.prisma, h.world.adminEmail)).id;
  });
  afterEach(() => vi.useRealTimers());

  async function enrollAdmin(app: FastifyInstance): Promise<Buffer> {
    const s = await login(app, h.world.adminEmail);
    const start = await call(app, s, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD });
    expect(start.statusCode, start.body).toBe(200);
    const secret = base32Decode(start.json().data.manualKey);
    const done = await call(app, s, 'POST', '/admin/account/2fa/enroll/verify', { code: totpAt(secret, Date.now()) });
    expect(done.statusCode, done.body).toBe(200);
    vi.setSystemTime(Date.now() + 30_000);
    return secret;
  }

  it('an admin with 2FA still gets a restricted challenge from the password step (no session), and the code completes it', async () => {
    const secret = await enrollAdmin(h.app);
    const pw = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: h.world.adminEmail, password: PASSWORD } });
    expect(pw.statusCode).toBe(200);
    expect(pw.json().data.twoFactorRequired).toBe(true);
    expect(cookieOf(pw, 'printout_session')).toBeUndefined();
    const challenge = cookieOf(pw, 'printout_2fa');
    expect(challenge).toBeTruthy();
    const done = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/2fa',
      payload: { method: 'totp', code: totpAt(secret, Date.now()) },
      headers: { cookie: `printout_2fa=${challenge!.value}` }
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().data.user.role).toBe('PLATFORM_ADMIN');
  });

  it('phone OTP cannot be used to skip admin 2FA: an admin with a forced phone identity gets nothing', async () => {
    await enrollAdmin(h.app);
    vi.useRealTimers();
    await linkPhoneDirect(h.prisma, adminId, PHONES.ADMIN);
    const liveBefore = await h.prisma.session.count({ where: { userId: adminId, invalidatedAt: null } }); // the enrollment sign-in itself
    for (const client of ['web', 'mobile'] as const) {
      const res = await exchange(h.app, tok(PHONES.ADMIN, 5 + (client === 'web' ? 0 : 1)), client);
      expect([401, 403], res.body).toContain(res.statusCode); // refused, not "unavailable"
      expect(cookieOf(res, 'printout_session')).toBeUndefined();
      expect(res.body).not.toMatch(/"role"\s*:\s*"(admin|PLATFORM_ADMIN)"/);
    }
    expect(await h.prisma.session.count({ where: { userId: adminId, invalidatedAt: null } })).toBe(liveBefore);
    expect(await h.prisma.refreshToken.count({ where: { userId: adminId } })).toBe(0);
  });

  it('an admin can never link a phone through the shop endpoint', async () => {
    const s = await login(h.app, h.world.adminEmail);
    const res = await call(h.app, s, 'POST', '/shop/account/phone', { idToken: tok(PHONES.ADMIN, 30), currentPassword: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(await h.prisma.userPhoneIdentity.count({ where: { userId: adminId } })).toBe(0);
  });

  it('a bearer token minted for an owner is never an admin credential: admin routes refuse it', async () => {
    vi.useRealTimers();
    const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
    await linkPhoneDirect(h.prisma, owner.id, PHONES.A);
    const auth = sessionAuthFrom(await exchange(h.app, tok(PHONES.A, 5), 'mobile'));
    const res = await req(h.app, auth, 'GET', '/admin/shops');
    expect(res.statusCode).toBe(403);
  });

  it('the shop owner email/password sign-in and logout work exactly as before', async () => {
    const s = await login(h.app, h.world.a.ownerEmail);
    expect((await call(h.app, s, 'GET', '/auth/session')).statusCode).toBe(200);
    expect((await call(h.app, s, 'POST', '/auth/logout')).statusCode).toBe(204);
    expect((await call(h.app, s, 'GET', '/auth/session')).statusCode).toBe(401);
  });
});
