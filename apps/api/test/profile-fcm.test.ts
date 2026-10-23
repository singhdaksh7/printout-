import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenHash } from '../src/auth.js';
import { decryptFcmToken, fcmKey, MAX_ACTIVE_REGISTRATIONS_PER_USER } from '../src/notifications/fcm-registrations.js';
import { login } from './api-helpers.js';
import {
  bearerAuth, collectKeys, cookieAuth, DEVICE_A, DEVICE_B, exchange, grantAuthFrom, linkPhoneDirect, makeShopReady, mobileSessionOf, PHONES, req, startHarness, tok,
  userByEmail, type Auth, type Harness
} from './helpers/profile-harness.js';

const INSTALL_1 = 'installation-1-0000000001';
const INSTALL_2 = 'installation-2-0000000002';
const TOKEN_1 = 'fcm-token-ONE-0123456789-abcdefghijklmnopqrstuvwxyz';
const TOKEN_2 = 'fcm-token-TWO-0123456789-abcdefghijklmnopqrstuvwxyz';
const TOKEN_3 = 'fcm-token-THREE-0123456789-abcdefghijklmnopqrstuvwxyz';

describe('FCM registration per installation (PUT/DELETE /users/me/fcm-token)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    await makeShopReady(h.prisma, h.world.a.shopId);
    await makeShopReady(h.prisma, h.world.b.shopId);
  });

  const sessionAs = async (email: string): Promise<Auth> => {
    const s = await login(h.app, email);
    return cookieAuth(s.cookie, s.csrf);
  };
  const asA = () => sessionAs(h.world.a.ownerEmail);
  const asB = () => sessionAs(h.world.b.ownerEmail);
  const idOf = async (email: string) => (await userByEmail(h.prisma, email)).id;
  const put = (auth: Auth, installationId: string, token: string, platform: unknown = 'android') =>
    req(h.app, auth, 'PUT', '/users/me/fcm-token', { installationId, token, platform });
  const del = (auth: Auth, body: Record<string, unknown>) => req(h.app, auth, 'DELETE', '/users/me/fcm-token', body);
  const rows = (where: Record<string, unknown> = {}) => h.prisma.fcmRegistration.findMany({ where, orderBy: { createdAt: 'asc' } });
  const active = (userId: string) => h.prisma.fcmRegistration.findMany({ where: { userId, enabled: true, revokedAt: null } });
  const key = () => fcmKey({ FCM_TOKEN_ENCRYPTION_KEY: undefined, SESSION_SECRET: process.env.SESSION_SECRET! });

  describe('access', () => {
    it('401 without credentials, 403 for a cookie without CSRF, 401/403 for a restricted onboarding grant', async () => {
      expect((await put(null, INSTALL_1, TOKEN_1)).statusCode).toBe(401);
      expect((await del(null, { installationId: INSTALL_1 })).statusCode).toBe(401);
      const s = await login(h.app, h.world.a.ownerEmail);
      expect((await put(cookieAuth(s.cookie), INSTALL_1, TOKEN_1)).statusCode).toBe(403);
      const grant = await exchange(h.app, tok(PHONES.NEW, 5), 'mobile');
      const g = grantAuthFrom(grant);
      expect([401, 403]).toContain((await put(g, INSTALL_1, TOKEN_1)).statusCode);
      expect(await rows()).toHaveLength(0);
    });

    it('an admin cannot register a push token', async () => {
      const admin = await sessionAs(h.world.adminEmail);
      const res = await put(admin, INSTALL_1, TOKEN_1);
      expect(res.statusCode, res.body).toBe(403);
      expect(await rows()).toHaveLength(0);
    });

    it('works for a bearer (mobile) session without CSRF', async () => {
      await linkPhoneDirect(h.prisma, await idOf(h.world.a.ownerEmail), PHONES.A);
      const a = mobileSessionOf(await exchange(h.app, tok(PHONES.A, 5), 'mobile', {}, DEVICE_A));
      const res = await put(bearerAuth(a.accessToken), DEVICE_A, TOKEN_1);
      expect(res.statusCode, res.body).toBe(200);
      expect(await active(await idOf(h.world.a.ownerEmail))).toHaveLength(1);
    });
  });

  describe('register / rotate / remove', () => {
    it('registers: 200 {registered, installationId, platform}; the response never contains the token', async () => {
      const res = await put(await asA(), INSTALL_1, TOKEN_1, 'ios');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({ registered: true, installationId: INSTALL_1, platform: 'ios' });
      expect(res.body).not.toContain(TOKEN_1);
    });

    it('stores the token ONLY encrypted (AES-GCM) plus a lookup hash; the owner/shop come from the session, not the client', async () => {
      await put(await asA(), INSTALL_1, TOKEN_1);
      const [row] = await rows();
      expect(row).toBeTruthy();
      expect(row!.tokenCipher).not.toContain(TOKEN_1);
      expect(row!.tokenCipher.startsWith('v1.')).toBe(true);
      expect(row!.tokenHash).toBe(tokenHash(TOKEN_1));
      expect(decryptFcmToken(key(), row!.tokenCipher)).toBe(TOKEN_1);
      expect(row!.userId).toBe(await idOf(h.world.a.ownerEmail));
      expect(row!.shopId).toBe(h.world.a.shopId);
      expect(row!.enabled).toBe(true);
      expect(row!.revokedAt).toBeNull();
      // a tampered ciphertext does not decrypt
      expect(decryptFcmToken(key(), row!.tokenCipher.slice(0, -3) + 'AAA')).toBeNull();
    });

    it('no raw token is in any column of any row, in the audit trail, or in any profile response', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      await put(auth, INSTALL_2, TOKEN_2);
      await del(auth, { installationId: INSTALL_2 });
      const dump = JSON.stringify({ regs: await rows(), audit: await h.prisma.auditLog.findMany(), sessions: await h.prisma.session.findMany() });
      for (const t of [TOKEN_1, TOKEN_2]) expect(dump.includes(t), t).toBe(false);
      for (const url of ['/users/me', '/shops/me', '/shops/me/qr', '/auth/session']) {
        const res = await req(h.app, auth, 'GET', url);
        for (const t of [TOKEN_1, TOKEN_2]) expect(res.body, url).not.toContain(t);
        const keys = collectKeys(res.json());
        for (const k of ['fcmToken', 'fcmTokens', 'tokenCipher', 'tokenHash', 'installationId']) expect(keys.has(k), `${url} leaks ${k}`).toBe(false);
      }
    });

    it('is idempotent per (user, installation): the same call twice is one row', async () => {
      const auth = await asA();
      expect((await put(auth, INSTALL_1, TOKEN_1)).statusCode).toBe(200);
      expect((await put(auth, INSTALL_1, TOKEN_1)).statusCode).toBe(200);
      expect(await rows()).toHaveLength(1);
    });

    it('rotation: a new token for the same installation replaces the old one in place (old hash gone, no second row)', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      const first = (await rows())[0]!;
      await put(auth, INSTALL_1, TOKEN_2);
      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe(first.id);
      expect(all[0]!.tokenHash).toBe(tokenHash(TOKEN_2));
      expect(decryptFcmToken(key(), all[0]!.tokenCipher)).toBe(TOKEN_2);
      expect(await h.prisma.fcmRegistration.count({ where: { tokenHash: tokenHash(TOKEN_1) } })).toBe(0);
    });

    it('several installations of one user are kept separately', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      await put(auth, INSTALL_2, TOKEN_2, 'ios');
      expect(await active(await idOf(h.world.a.ownerEmail))).toHaveLength(2);
    });

    it('removal by installationId revokes the registration: disabled, ciphertext wiped, hash freed; always 204', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      const res = await del(auth, { installationId: INSTALL_1 });
      expect(res.statusCode).toBe(204);
      const [row] = await rows();
      expect(row).toMatchObject({ enabled: false, tokenCipher: '' });
      expect(row!.revokedAt).toBeInstanceOf(Date);
      expect(row!.tokenHash.startsWith('revoked:')).toBe(true);
      // the same token may be registered again afterwards
      expect((await put(auth, INSTALL_2, TOKEN_1)).statusCode).toBe(200);
    });

    it('removal by token works too, and a repeated removal is still 204', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      expect((await del(auth, { token: TOKEN_1 })).statusCode).toBe(204);
      expect((await active(await idOf(h.world.a.ownerEmail)))).toHaveLength(0);
      expect((await del(auth, { token: TOKEN_1 })).statusCode).toBe(204);
      expect((await del(auth, { installationId: 'never-registered-0000000001' })).statusCode).toBe(204);
    });

    it('removing a registration re-enables nothing by itself, but re-registering the same installation re-activates the row', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      await del(auth, { installationId: INSTALL_1 });
      expect((await put(auth, INSTALL_1, TOKEN_3)).statusCode).toBe(200);
      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ enabled: true, revokedAt: null, failureCount: 0 });
      expect(decryptFcmToken(key(), all[0]!.tokenCipher)).toBe(TOKEN_3);
    });
  });

  describe('validation', () => {
    it('rejects malformed registrations with 400 and stores nothing', async () => {
      const auth = await asA();
      const bad: unknown[] = [
        {},
        { token: TOKEN_1, platform: 'android' }, // no installationId
        { installationId: INSTALL_1, platform: 'android' }, // no token
        { installationId: INSTALL_1, token: TOKEN_1 }, // no platform
        { installationId: INSTALL_1, token: 'short', platform: 'android' },
        { installationId: INSTALL_1, token: 't'.repeat(5000), platform: 'android' },
        { installationId: INSTALL_1, token: 'has a space inside the token 0123456789', platform: 'android' },
        { installationId: INSTALL_1, token: TOKEN_1, platform: 'blackberry' },
        { installationId: 'x', token: TOKEN_1, platform: 'android' },
        { installationId: INSTALL_1, token: TOKEN_1, platform: 'android', userId: 'someone-else' },
        { installationId: INSTALL_1, token: TOKEN_1, platform: 'android', shopId: h.world.b.shopId }
      ];
      for (const body of bad) {
        const res = await req(h.app, auth, 'PUT', '/users/me/fcm-token', body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 90)).toBe(400);
      }
      expect(await rows()).toHaveLength(0);
    });

    it('DELETE needs exactly one of installationId or token', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      for (const body of [{}, { installationId: INSTALL_1, token: TOKEN_1 }, { installationId: INSTALL_1, extra: 1 }]) {
        expect((await del(auth, body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(await active(await idOf(h.world.a.ownerEmail))).toHaveLength(1);
    });
  });

  describe('cross-user ownership', () => {
    it('user B cannot alter A’s installation row: B registering the SAME installationId gets its own row; A’s is untouched', async () => {
      await put(await asA(), INSTALL_1, TOKEN_1);
      await put(await asB(), INSTALL_1, TOKEN_2);
      const a = await rows({ userId: await idOf(h.world.a.ownerEmail) });
      const b = await rows({ userId: await idOf(h.world.b.ownerEmail) });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(decryptFcmToken(key(), a[0]!.tokenCipher)).toBe(TOKEN_1);
      expect(a[0]).toMatchObject({ enabled: true, revokedAt: null, shopId: h.world.a.shopId });
      expect(b[0]!.shopId).toBe(h.world.b.shopId);
    });

    it('B cannot remove A’s registration by installationId or by token (same 204, nothing happens)', async () => {
      await put(await asA(), INSTALL_1, TOKEN_1);
      const b = await asB();
      expect((await del(b, { installationId: INSTALL_1 })).statusCode).toBe(204);
      expect((await del(b, { token: TOKEN_1 })).statusCode).toBe(204);
      const [row] = await rows({ userId: await idOf(h.world.a.ownerEmail) });
      expect(row).toMatchObject({ enabled: true, revokedAt: null });
      expect(row!.tokenHash).toBe(tokenHash(TOKEN_1));
    });

    it('the same token appearing under a new holder revokes the old holder’s registration (a device changed hands)', async () => {
      await put(await asA(), INSTALL_1, TOKEN_1);
      const moved = await put(await asB(), INSTALL_2, TOKEN_1);
      expect(moved.statusCode, moved.body).toBe(200);
      const a = await rows({ userId: await idOf(h.world.a.ownerEmail) });
      expect(a[0]).toMatchObject({ enabled: false, tokenCipher: '' });
      expect(a[0]!.revokedAt).toBeInstanceOf(Date);
      const b = await active(await idOf(h.world.b.ownerEmail));
      expect(b).toHaveLength(1);
      expect(b[0]!.tokenHash).toBe(tokenHash(TOKEN_1));
    });

    it('the same token moved to another installation of the SAME user also revokes the old installation (no duplicate delivery)', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      await put(auth, INSTALL_2, TOKEN_1);
      const live = await active(await idOf(h.world.a.ownerEmail));
      expect(live).toHaveLength(1);
      expect(live[0]!.installationId).toBe(INSTALL_2);
    });

    it('concurrent registrations of the same token from two users leave exactly one live holder', async () => {
      const a = await asA();
      const b = await asB();
      const results = await Promise.all([put(a, INSTALL_1, TOKEN_1), put(b, INSTALL_2, TOKEN_1), put(a, INSTALL_1, TOKEN_1), put(b, INSTALL_2, TOKEN_1)]);
      for (const r of results) expect([200, 409], r.body).toContain(r.statusCode);
      const live = await h.prisma.fcmRegistration.findMany({ where: { tokenHash: tokenHash(TOKEN_1) } });
      expect(live.length).toBeLessThanOrEqual(1);
    });
  });

  describe('limits and cleanup', () => {
    it(`a user keeps at most ${MAX_ACTIVE_REGISTRATIONS_PER_USER} active registrations; the newest win`, async () => {
      const auth = await asA();
      const total = MAX_ACTIVE_REGISTRATIONS_PER_USER + 5;
      for (let i = 0; i < total; i++) {
        const n = String(i).padStart(3, '0');
        expect((await put(auth, `install-${n}-00000000000000`, `fcm-bulk-${n}-0123456789-abcdefghijklmnopqrstuvwxyz`)).statusCode).toBe(200);
      }
      const live = await active(await idOf(h.world.a.ownerEmail));
      expect(live).toHaveLength(MAX_ACTIVE_REGISTRATIONS_PER_USER);
      const newest = `install-${String(total - 1).padStart(3, '0')}-00000000000000`;
      expect(live.some((r) => r.installationId === newest)).toBe(true);
      const oldest = await h.prisma.fcmRegistration.findFirstOrThrow({ where: { installationId: 'install-000-00000000000000' } });
      expect(oldest.enabled).toBe(false);
    });

    it('device logout (Bearer) removes that installation’s registration and leaves other devices alone', async () => {
      await linkPhoneDirect(h.prisma, await idOf(h.world.a.ownerEmail), PHONES.A);
      const a = mobileSessionOf(await exchange(h.app, tok(PHONES.A, 20), 'mobile', {}, DEVICE_A));
      const b = mobileSessionOf(await exchange(h.app, tok(PHONES.A, 15), 'mobile', {}, DEVICE_B));
      await put(bearerAuth(a.accessToken), DEVICE_A, TOKEN_1);
      await put(bearerAuth(b.accessToken), DEVICE_B, TOKEN_2);
      expect((await req(h.app, bearerAuth(a.accessToken), 'POST', '/auth/logout')).statusCode).toBe(204);
      const live = await active(await idOf(h.world.a.ownerEmail));
      expect(live.map((r) => r.installationId)).toEqual([DEVICE_B]);
    });

    it('logout-all removes every registration unless keepPush is set', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      await put(auth, INSTALL_2, TOKEN_2);
      const keep = await req(h.app, auth, 'POST', '/auth/logout-all', { keepPush: true });
      expect(keep.statusCode, keep.body).toBe(204);
      expect(await active(await idOf(h.world.a.ownerEmail))).toHaveLength(2);
      const auth2 = await asA();
      expect((await req(h.app, auth2, 'POST', '/auth/logout-all')).statusCode).toBe(204);
      expect(await active(await idOf(h.world.a.ownerEmail))).toHaveLength(0);
      expect(JSON.stringify(await rows())).not.toContain(TOKEN_1);
    });

    it('deleting the user cascades their registrations', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      const id = await idOf(h.world.a.ownerEmail);
      await h.prisma.user.delete({ where: { id } });
      expect(await rows({ userId: id })).toHaveLength(0);
    });

    it('audit rows for register/remove carry no token, installation id or ciphertext', async () => {
      const auth = await asA();
      await put(auth, INSTALL_1, TOKEN_1);
      await del(auth, { token: TOKEN_1 });
      const audits = await h.prisma.auditLog.findMany({ where: { action: { startsWith: 'user.fcm_token' } } });
      expect(audits.length).toBeGreaterThanOrEqual(2);
      const blob = JSON.stringify(audits);
      for (const secret of [TOKEN_1, INSTALL_1, tokenHash(TOKEN_1)]) expect(blob.includes(secret)).toBe(false);
    });
  });
});
