import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenHash } from '../src/auth.js';
import { call, login, PASSWORD } from './api-helpers.js';
import {
  bearerAuth, cookieAuth, cookieOf, DEVICE_A, DEVICE_B, exchange, grantAuthFrom, linkPhoneDirect, makeShopReady, mobileSessionOf, nextStepOf, PHONES, refresh, req,
  startHarness, tok, userByEmail, userOf, type Harness
} from './helpers/profile-harness.js';

describe('mobile credentials: access token + rotating refresh token', () => {
  let h: Harness;
  /** Every OTP must be newer than the last one for this phone (replay protection), so the age counts down. */
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
    await linkPhoneDirect(h.prisma, (await userByEmail(h.prisma, h.world.a.ownerEmail)).id, PHONES.A);
  });

  /** Fresh mobile sign-in for owner A on a device; returns the credentials. */
  async function mobileLogin(deviceId = DEVICE_A) {
    const res = await exchange(h.app, tok(PHONES.A, age--), 'mobile', {}, deviceId);
    expect(res.statusCode, res.body).toBe(200);
    return { res, ...mobileSessionOf(res) };
  }
  const me = (accessToken: string) => req(h.app, bearerAuth(accessToken), 'GET', '/users/me');
  const ownerId = async () => (await userByEmail(h.prisma, h.world.a.ownerEmail)).id;
  const liveRefresh = async (familyId?: string) =>
    h.prisma.refreshToken.findMany({ where: { userId: await ownerId(), revokedAt: null, rotatedAt: null, ...(familyId ? { familyId } : {}) } });
  const familyOf = async (refreshToken: string) => (await h.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: tokenHash(refreshToken) } })).familyId;
  const sameError = (a: { json(): any }, b: { json(): any }) => {
    const strip = (r: { json(): any }) => {
      const e = { ...r.json().error };
      delete e.requestId;
      return e;
    };
    expect(strip(a)).toEqual(strip(b));
  };

  describe('issuing', () => {
    it('a mobile exchange returns an access token, a refresh token, their expiries and sets no cookie', async () => {
      const { res, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, transport } = await mobileLogin();
      expect(transport).toBe('bearer'); // tokenType Bearer
      expect(accessToken).toEqual(expect.any(String));
      expect(refreshToken).toEqual(expect.any(String));
      expect(refreshToken).not.toBe(accessToken);
      expect(res.cookies.length).toBe(0);
      const access = Date.parse(accessTokenExpiresAt) - Date.now();
      expect(access).toBeGreaterThan(10 * 60_000); // 15 minutes by default
      expect(access).toBeLessThanOrEqual(15 * 60_000 + 5_000);
      const refreshTtl = Date.parse(refreshTokenExpiresAt) - Date.now();
      expect(refreshTtl).toBeGreaterThan(29 * 86_400_000); // 30 days by default
      expect(refreshTtl).toBeLessThanOrEqual(30 * 86_400_000 + 5_000);
      expect((await me(accessToken)).statusCode).toBe(200);
    });

    it('requires a deviceId on mobile exchanges and validates it; web exchanges need none', async () => {
      for (const deviceId of [undefined, '', 'short', 'x'.repeat(300), 12345, 'has spaces and !!! chars']) {
        const res = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/firebase/exchange',
          payload: { idToken: tok(PHONES.A, age--), client: 'mobile', ...(deviceId === undefined ? {} : { deviceId }) }
        });
        expect(res.statusCode, String(deviceId)).toBe(400);
      }
      const web = await exchange(h.app, tok(PHONES.A, age--), 'web');
      expect(web.statusCode, web.body).toBe(200);
      expect(cookieOf(web, 'printout_session')).toBeTruthy();
      expect(JSON.stringify(web.json().data.session)).not.toMatch(/refresh/i); // web never gets a refresh token
    });

    it('the three credentials are different secrets: Firebase ID token, access token and refresh token never substitute for each other', async () => {
      const idToken = tok(PHONES.A, age--);
      const res = await exchange(h.app, idToken, 'mobile');
      const { accessToken, refreshToken } = mobileSessionOf(res);
      expect((await me(refreshToken)).statusCode).toBe(401); // refresh token is not an access token
      expect((await me(idToken)).statusCode).toBe(401); // Firebase ID token is not an access token
      expect((await refresh(h.app, accessToken)).statusCode).toBe(401); // access token is not a refresh token
      expect([400, 401]).toContain((await refresh(h.app, idToken)).statusCode); // longer than any refresh token: shape-rejected
    });

    it('signing in again on the SAME device supersedes the earlier family; another device is untouched', async () => {
      const first = await mobileLogin(DEVICE_A);
      const other = await mobileLogin(DEVICE_B);
      const second = await mobileLogin(DEVICE_A);
      expect((await me(first.accessToken)).statusCode).toBe(401);
      expect((await refresh(h.app, first.refreshToken)).statusCode).toBe(401);
      expect((await me(second.accessToken)).statusCode).toBe(200);
      expect((await me(other.accessToken)).statusCode).toBe(200);
      expect((await refresh(h.app, other.refreshToken, DEVICE_B)).statusCode).toBe(200);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates: new access + refresh token, the old access token stops working and the old refresh token is spent', async () => {
      const a = await mobileLogin();
      const res = await refresh(h.app, a.refreshToken);
      expect(res.statusCode, res.body).toBe(200);
      const b = mobileSessionOf(res);
      expect(b.transport ?? 'bearer').toBe('bearer');
      expect(b.accessToken).not.toBe(a.accessToken);
      expect(b.refreshToken).not.toBe(a.refreshToken);
      expect(res.cookies.length).toBe(0);
      expect(Date.parse(b.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
      expect((await me(b.accessToken)).statusCode).toBe(200);
      expect((await me(a.accessToken)).statusCode).toBe(401);
      // one live refresh token per family at any moment
      expect(await liveRefresh(await familyOf(b.refreshToken))).toHaveLength(1);
      expect(userOf(await me(b.accessToken)).id).toBe(await ownerId());
    });

    it('a chain of refreshes keeps working (each token used exactly once)', async () => {
      let cur = await mobileLogin();
      for (let i = 0; i < 4; i++) {
        const res = await refresh(h.app, cur.refreshToken);
        expect(res.statusCode, `${i}: ${res.body}`).toBe(200);
        cur = { ...cur, ...mobileSessionOf(res) };
        expect((await me(cur.accessToken)).statusCode).toBe(200);
      }
    });

    it('works after the access token has expired (that is the point of a refresh token)', async () => {
      const a = await mobileLogin();
      await h.prisma.session.updateMany({ where: { userId: await ownerId() }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      expect((await me(a.accessToken)).statusCode).toBe(401);
      const res = await refresh(h.app, a.refreshToken);
      expect(res.statusCode, res.body).toBe(200);
      expect((await me(mobileSessionOf(res).accessToken)).statusCode).toBe(200);
    });

    it('an expired refresh token is refused (401 REFRESH_TOKEN_EXPIRED) and issues nothing', async () => {
      const a = await mobileLogin();
      await h.prisma.refreshToken.updateMany({ where: { tokenHash: tokenHash(a.refreshToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await refresh(h.app, a.refreshToken);
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe('REFRESH_TOKEN_EXPIRED');
      expect(res.body).not.toMatch(/accessToken|refreshToken/);
    });

    it('forged, garbage, truncated and empty refresh tokens all get the identical 401 (nothing to tell them apart)', async () => {
      const a = await mobileLogin();
      const responses = [
        await refresh(h.app, 'A'.repeat(43)),
        await refresh(h.app, 'B'.repeat(43)),
        await refresh(h.app, a.refreshToken.slice(0, 20)),
        await refresh(h.app, a.refreshToken.slice(0, -1) + (a.refreshToken.endsWith('A') ? 'B' : 'A')),
        await refresh(h.app, 'z'.repeat(86)),
        // shape never matters: too short, too long, empty, non-string and missing all answer the same generic 401 (no oracle)
        await refresh(h.app, 'not-a-real-token'),
        await refresh(h.app, 'x'.repeat(600)),
        await refresh(h.app, ''),
        await refresh(h.app, 12345),
        await h.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { deviceId: DEVICE_A } })
      ];
      for (const r of responses) {
        expect(r.statusCode, r.body).toBe(401);
        expect(r.json().error.code).toBe('REFRESH_TOKEN_INVALID');
      }
      for (const r of responses.slice(1)) sameError(responses[0]!, r);
      // none of those probes touched the real family
      expect((await refresh(h.app, a.refreshToken)).statusCode).toBe(200);
    });

    it('validates the body: missing or non-string fields and extra keys are 400', async () => {
      const a = await mobileLogin();
      // a missing/odd refresh token is a generic 401 (see the forged-token test); a missing deviceId or unknown keys are 400
      for (const payload of [{}, { refreshToken: a.refreshToken }, { refreshToken: a.refreshToken, deviceId: DEVICE_A, userId: 'x' }, { refreshToken: a.refreshToken, deviceId: 'x' }]) {
        const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload });
        expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      }
      expect((await refresh(h.app, a.refreshToken)).statusCode).toBe(200); // still intact
    });

    it('needs neither a cookie nor CSRF, and a stray session cookie is ignored', async () => {
      const a = await mobileLogin();
      const web = await login(h.app, h.world.a.ownerEmail);
      const res = await refresh(h.app, a.refreshToken, DEVICE_A, { cookie: web.cookie });
      expect(res.statusCode, res.body).toBe(200);
      expect(cookieOf(res, 'printout_session')).toBeUndefined();
    });

    it('a different deviceId is refused AND the whole family is revoked (a stolen token on another device is useless)', async () => {
      const a = await mobileLogin();
      const res = await refresh(h.app, a.refreshToken, DEVICE_B);
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe('REFRESH_TOKEN_INVALID');
      expect((await me(a.accessToken)).statusCode).toBe(401);
      expect((await refresh(h.app, a.refreshToken, DEVICE_A)).statusCode).toBe(401);
    });
  });

  describe('reuse detection', () => {
    it('re-presenting an already-rotated token (after the grace window) revokes the WHOLE family, including the newest access session', async () => {
      const a = await mobileLogin();
      const b = mobileSessionOf(await refresh(h.app, a.refreshToken));
      expect((await me(b.accessToken)).statusCode).toBe(200);
      // Age the rotation beyond the reuse-grace window (default 5 s) instead of sleeping.
      await h.prisma.refreshToken.updateMany({ where: { tokenHash: tokenHash(a.refreshToken) }, data: { rotatedAt: new Date(Date.now() - 60_000) } });

      const replay = await refresh(h.app, a.refreshToken);
      expect(replay.statusCode, replay.body).toBe(401);
      expect(replay.json().error.code).toBe('REFRESH_TOKEN_INVALID');

      expect((await me(b.accessToken)).statusCode).toBe(401); // the attacker's AND the victim's newest session are both dead
      expect((await refresh(h.app, b.refreshToken)).statusCode).toBe(401);
      expect(await liveRefresh()).toHaveLength(0);
      const audit = await h.prisma.auditLog.findMany({ where: { action: 'auth.refresh.reuse_detected' } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(a.refreshToken);
    });

    it('a presented token that was revoked (e.g. by logout) is treated as reuse and kills the family', async () => {
      const a = await mobileLogin();
      expect((await req(h.app, bearerAuth(a.accessToken), 'POST', '/auth/logout')).statusCode).toBe(204);
      const res = await refresh(h.app, a.refreshToken);
      expect(res.statusCode).toBe(401);
      expect(await liveRefresh()).toHaveLength(0);
    });

    it('reuse in one device family does not revoke the owner’s other device', async () => {
      const a = await mobileLogin(DEVICE_A);
      const b = await mobileLogin(DEVICE_B);
      const a2 = mobileSessionOf(await refresh(h.app, a.refreshToken, DEVICE_A));
      await h.prisma.refreshToken.updateMany({ where: { tokenHash: tokenHash(a.refreshToken) }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
      expect((await refresh(h.app, a.refreshToken, DEVICE_A)).statusCode).toBe(401);
      expect((await me(a2.accessToken)).statusCode).toBe(401);
      expect((await me(b.accessToken)).statusCode).toBe(200);
      expect((await refresh(h.app, b.refreshToken, DEVICE_B)).statusCode).toBe(200);
    });
  });

  describe('concurrency and the grace window', () => {
    it('N parallel refreshes of the same token: exactly one wins, the rest are 409/401, and there is never more than one live successor', async () => {
      const a = await mobileLogin();
      const results = await Promise.all(Array.from({ length: 8 }, () => refresh(h.app, a.refreshToken)));
      const winners = results.filter((r) => r.statusCode === 200);
      expect(winners).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) expect([401, 409], r.body).toContain(r.statusCode);
      const family = await familyOf(a.refreshToken);
      expect(await liveRefresh(family)).toHaveLength(1);
      const liveSessions = await h.prisma.session.count({ where: { familyId: family, invalidatedAt: null, expiresAt: { gt: new Date() } } });
      expect(liveSessions).toBe(1);
      const winner = mobileSessionOf(winners[0]!);
      expect((await me(winner.accessToken)).statusCode).toBe(200);
    });

    it('an immediate retry of the just-used token is a 409 (client race), does NOT revoke anything, and the new token still works', async () => {
      const a = await mobileLogin();
      const b = mobileSessionOf(await refresh(h.app, a.refreshToken));
      const retry = await refresh(h.app, a.refreshToken);
      expect(retry.statusCode, retry.body).toBe(409);
      expect(retry.json().error.code).toBe('REFRESH_CONFLICT');
      expect(retry.body).not.toMatch(/accessToken|refreshToken/);
      expect((await me(b.accessToken)).statusCode).toBe(200);
      expect((await refresh(h.app, b.refreshToken)).statusCode).toBe(200);
      expect(await h.prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected' } })).toBe(0);
    });
  });

  describe('logout', () => {
    it('Bearer logout ends the access session and the whole refresh family', async () => {
      const a = await mobileLogin();
      expect((await req(h.app, bearerAuth(a.accessToken), 'POST', '/auth/logout')).statusCode).toBe(204);
      expect((await me(a.accessToken)).statusCode).toBe(401);
      const res = await refresh(h.app, a.refreshToken);
      expect(res.statusCode).toBe(401);
      expect(await liveRefresh()).toHaveLength(0);
    });

    it('cookie logout with CSRF still works and without CSRF is refused', async () => {
      const s = await login(h.app, h.world.a.ownerEmail);
      expect((await req(h.app, cookieAuth(s.cookie), 'POST', '/auth/logout')).statusCode).toBe(403);
      expect((await call(h.app, s, 'POST', '/auth/logout')).statusCode).toBe(204);
      expect((await call(h.app, s, 'GET', '/auth/session')).statusCode).toBe(401);
    });

    it('device logout does not touch another device', async () => {
      const a = await mobileLogin(DEVICE_A);
      const b = await mobileLogin(DEVICE_B);
      expect((await req(h.app, bearerAuth(a.accessToken), 'POST', '/auth/logout')).statusCode).toBe(204);
      expect((await me(a.accessToken)).statusCode).toBe(401);
      expect((await me(b.accessToken)).statusCode).toBe(200);
      expect((await refresh(h.app, b.refreshToken, DEVICE_B)).statusCode).toBe(200);
    });

    it('logout-all ends every session and refresh family of the user (cookie and bearer alike)', async () => {
      const a = await mobileLogin(DEVICE_A);
      const b = await mobileLogin(DEVICE_B);
      const web = await login(h.app, h.world.a.ownerEmail);
      const other = await login(h.app, h.world.b.ownerEmail);
      const res = await req(h.app, bearerAuth(a.accessToken), 'POST', '/auth/logout-all');
      expect([200, 204], res.body).toContain(res.statusCode);
      expect((await me(a.accessToken)).statusCode).toBe(401);
      expect((await me(b.accessToken)).statusCode).toBe(401);
      expect((await call(h.app, web, 'GET', '/auth/session')).statusCode).toBe(401);
      expect((await refresh(h.app, a.refreshToken, DEVICE_A)).statusCode).toBe(401);
      expect((await refresh(h.app, b.refreshToken, DEVICE_B)).statusCode).toBe(401);
      expect(await liveRefresh()).toHaveLength(0);
      // never someone else's sessions
      expect((await call(h.app, other, 'GET', '/auth/session')).statusCode).toBe(200);
    });

    it('logout and logout-all require authentication', async () => {
      expect((await req(h.app, null, 'POST', '/auth/logout-all')).statusCode).toBe(401);
      expect((await req(h.app, bearerAuth('x'.repeat(43)), 'POST', '/auth/logout-all')).statusCode).toBe(401);
    });
  });

  describe('account state and credential changes', () => {
    it('a suspended shop cannot refresh (403) and its family is revoked even after the suspension is lifted', async () => {
      const a = await mobileLogin();
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'SUSPENDED' } });
      const res = await refresh(h.app, a.refreshToken);
      expect(res.statusCode, res.body).toBe(403);
      expect(['ACCOUNT_BLOCKED', 'SHOP_SUSPENDED']).toContain(res.json().error.code);
      expect(res.body).not.toMatch(/accessToken|refreshToken/);
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'ACTIVE' } });
      expect((await refresh(h.app, a.refreshToken)).statusCode).toBe(401);
      expect((await me(a.accessToken)).statusCode).toBe(401);
    });

    it('an account that is no longer a shop owner cannot refresh, and the family is revoked', async () => {
      const a = await mobileLogin();
      await h.prisma.user.update({ where: { id: await ownerId() }, data: { role: 'PLATFORM_ADMIN', shopId: null } });
      const res = await refresh(h.app, a.refreshToken);
      expect(res.statusCode, res.body).toBe(403);
      expect(await liveRefresh()).toHaveLength(0);
    });

    it('a deleted account loses every credential', async () => {
      const a = await mobileLogin();
      await h.prisma.user.delete({ where: { id: await ownerId() } });
      expect((await refresh(h.app, a.refreshToken)).statusCode).toBe(401);
      expect((await me(a.accessToken)).statusCode).toBe(401);
    });

    it('changing the account email (re-authenticated with the password) revokes the owner’s other devices’ refresh families', async () => {
      const a = await mobileLogin(DEVICE_A);
      const b = await mobileLogin(DEVICE_B);
      const res = await req(h.app, bearerAuth(a.accessToken), 'PATCH', '/users/me', { email: 'renamed-owner@a.test', currentPassword: PASSWORD });
      expect(res.statusCode, res.body).toBe(200);
      expect((await refresh(h.app, b.refreshToken, DEVICE_B)).statusCode).toBe(401);
      expect((await me(b.accessToken)).statusCode).toBe(401);
    });

    it('unlinking the phone revokes the other devices’ refresh families (a lost phone cannot keep a session alive)', async () => {
      const a = await mobileLogin(DEVICE_A);
      const b = await mobileLogin(DEVICE_B);
      const res = await req(h.app, bearerAuth(a.accessToken), 'POST', '/shop/account/phone/unlink', { currentPassword: PASSWORD });
      expect(res.statusCode, res.body).toBe(200);
      expect((await refresh(h.app, b.refreshToken, DEVICE_B)).statusCode).toBe(401);
      expect((await me(b.accessToken)).statusCode).toBe(401);
    });
  });

  describe('storage and secrecy', () => {
    it('only hashes are stored: no raw access token, refresh token or Firebase ID token appears in any table we hold', async () => {
      const idToken = tok(PHONES.A, age--);
      const first = await exchange(h.app, idToken, 'mobile');
      const a = mobileSessionOf(first);
      const b = mobileSessionOf(await refresh(h.app, a.refreshToken));
      await refresh(h.app, a.refreshToken).catch(() => undefined); // 409 path
      const dump = JSON.stringify({
        refresh: await h.prisma.refreshToken.findMany(),
        sessions: await h.prisma.session.findMany(),
        audit: await h.prisma.auditLog.findMany(),
        grants: await h.prisma.phoneOnboardingGrant.findMany(),
        identities: await h.prisma.userPhoneIdentity.findMany(),
        users: await h.prisma.user.findMany({ select: { id: true, email: true, displayName: true } })
      });
      for (const secret of [a.accessToken, a.refreshToken, b.accessToken, b.refreshToken, idToken]) expect(dump.includes(secret), `${secret.slice(0, 10)}…`).toBe(false);
      const rows = await h.prisma.refreshToken.findMany();
      expect(rows.some((r) => r.tokenHash === tokenHash(a.refreshToken))).toBe(true);
      expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.tokenHash))).toBe(true);
    });

    it('responses never contain the Firebase UID, and error bodies never echo tokens', async () => {
      const a = await mobileLogin();
      for (const res of [await refresh(h.app, 'secret-looking-token-value-123456789'), await refresh(h.app, a.refreshToken, DEVICE_B)]) {
        expect(res.body).not.toContain('secret-looking-token-value');
        expect(res.body).not.toContain(a.refreshToken);
        expect(res.body).not.toContain(`uid-${PHONES.A}`);
      }
    });
  });

  it('a phone-onboarded owner can use the same credentials flow end to end', async () => {
    const grantRes = await exchange(h.app, tok(PHONES.NEW, 5), 'mobile');
    const grant = grantAuthFrom(grantRes);
    const created = await req(h.app, grant, 'POST', '/shops/onboarding', {
      ownerName: 'Asha Verma', email: 'asha@newshop.test', shopName: 'Asha Prints', address: '45 Park Street, Kolkata', pincode: '700016',
      client: 'mobile', deviceId: DEVICE_A
    });
    expect([200, 201], created.body).toContain(created.statusCode);
    const session = mobileSessionOf(created);
    expect(session.refreshToken).toEqual(expect.any(String));
    const next = await refresh(h.app, session.refreshToken, DEVICE_A);
    expect(next.statusCode, next.body).toBe(200);
    expect((await me(mobileSessionOf(next).accessToken)).statusCode).toBe(200);
    const again = await exchange(h.app, tok(PHONES.NEW, 3), 'mobile', {}, DEVICE_B);
    expect(again.statusCode, again.body).toBe(200);
    expect(nextStepOf(again)).toBe('generate_qr');
  });
});
