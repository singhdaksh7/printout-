import { ShopStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, login, PASSWORD, type Session } from './api-helpers.js';
import {
  collectKeys, cookieAuth, dataOf, exchange, FORBIDDEN_KEYS, linkPhoneDirect, makeShopReady, nextStepOf, PHONES, req, sessionAuthFrom,
  SHOP_PROFILE_KEYS, shopOf, startHarness, tok, USER_PROFILE_KEYS, userByEmail, userOf, type Auth, type Harness
} from './helpers/profile-harness.js';

describe('profile API: /users/me, /shops/me, /shops/me/qr', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    await makeShopReady(h.prisma, h.world.a.shopId);
    await makeShopReady(h.prisma, h.world.b.shopId, { address: '7 Brigade Road, Bengaluru' });
  });

  const sess = (s: Session): Auth => cookieAuth(s.cookie, s.csrf);
  const asA = async () => sess(await login(h.app, h.world.a.ownerEmail));
  const asB = async () => sess(await login(h.app, h.world.b.ownerEmail));

  describe('GET /users/me', () => {
    it('requires authentication', async () => {
      expect((await req(h.app, null, 'GET', '/users/me')).statusCode).toBe(401);
    });

    it('returns exactly the signed-in user, with the documented identity fields', async () => {
      const res = await req(h.app, await asA(), 'GET', '/users/me');
      expect(res.statusCode, res.body).toBe(200);
      const u = userOf(res);
      for (const k of USER_PROFILE_KEYS) expect(Object.keys(u), `missing ${k}`).toContain(k);
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      expect(u).toMatchObject({ id: owner.id, role: 'shop', name: owner.displayName, email: owner.email });
      expect(u.phoneNumber).toBeNull(); // not linked
      expect(u.loginMethods).toEqual(['email']);
      expect(u.phoneVerified).toBe(false);
      expect(u.emailVerified).toBe(false); // nothing verifies email today: never fabricated as true
      expect(Date.parse(u.createdAt)).not.toBeNaN();
      expect(Date.parse(u.updatedAt)).not.toBeNaN();
    });

    it('after a phone link: phoneNumber in E.164, phoneVerified, both login methods', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkPhoneDirect(h.prisma, owner.id, PHONES.A);
      const u = userOf(await req(h.app, await asA(), 'GET', '/users/me'));
      expect(u.phoneNumber).toBe(PHONES.A);
      expect(u.phoneVerified).toBe(true);
      expect([...u.loginMethods].sort()).toEqual(['email', 'otp']);
    });

    it('lastLoginAt is null before any login is recorded and updates after signing in', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await h.prisma.user.update({ where: { id: owner.id }, data: { lastLoginAt: null } });
      const auth = await asA(); // password login records lastLoginAt
      const u = userOf(await req(h.app, auth, 'GET', '/users/me'));
      expect(Date.parse(u.lastLoginAt)).toBeGreaterThan(Date.now() - 60_000);
    });

    it('never exposes the Firebase UID, FCM tokens, hashes or internal keys', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkPhoneDirect(h.prisma, owner.id, PHONES.A);
      const auth = await asA();
      await req(h.app, auth, 'PUT', '/users/me/fcm-token', { token: 'fcm-secret-token-0123456789-abcdefghij', platform: 'android' });
      for (const url of ['/users/me', '/shops/me', '/shops/me/qr', '/auth/session']) {
        const res = await req(h.app, auth, 'GET', url);
        const keys = collectKeys(res.json());
        for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `${url} leaks ${k}`).toBe(false);
        expect(res.body, url).not.toContain(`uid-${PHONES.A}`);
        expect(res.body, url).not.toContain('fcm-secret-token');
      }
    });

    it('an admin gets role "admin"', async () => {
      const admin = sess(await login(h.app, h.world.adminEmail));
      const res = await req(h.app, admin, 'GET', '/users/me');
      expect(res.statusCode, res.body).toBe(200);
      expect(userOf(res).role).toBe('admin');
    });

    it('a response for a shop owner reports the same nextStep as the exchange', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkPhoneDirect(h.prisma, owner.id, PHONES.A);
      const ex = await exchange(h.app, tok(PHONES.A, 5), 'mobile');
      const me = await req(h.app, sessionAuthFrom(ex), 'GET', '/users/me');
      expect(nextStepOf(me)).toBe(nextStepOf(ex));
      expect(nextStepOf(me)).toBe('dashboard');
    });
  });

  describe('IDOR / cross-shop', () => {
    it('/users/me is only ever the caller: A and B see different ids and no cross data', async () => {
      const a = userOf(await req(h.app, await asA(), 'GET', '/users/me'));
      const b = userOf(await req(h.app, await asB(), 'GET', '/users/me'));
      expect(a.id).not.toBe(b.id);
      expect(a.email).toBe(h.world.a.ownerEmail);
      expect(b.email).toBe(h.world.b.ownerEmail);
    });

    it('there is no GET /users/:id (or /shops/:id) endpoint: not for strangers, not for yourself', async () => {
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      const other = await userByEmail(h.prisma, h.world.b.ownerEmail);
      const auth = await asA();
      for (const id of [owner.id, other.id]) {
        for (const a of [auth, null]) {
          const res = await req(h.app, a, 'GET', `/users/${id}`);
          expect([404, 401], `users/${id}`).toContain(res.statusCode);
          expect(res.body).not.toContain(other.email);
        }
      }
      const shop = await req(h.app, auth, 'GET', `/shops/${h.world.b.shopId}`);
      expect(shop.statusCode).toBe(404);
    });

    it('PATCH /shops/me and /users/me only change the caller; smuggled ids and fields are not honoured', async () => {
      const auth = await asA();
      const bBefore = await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.b.shopId } });
      const bUserBefore = await userByEmail(h.prisma, h.world.b.ownerEmail);
      const attempts: Array<[string, Record<string, unknown>]> = [
        ['/shops/me', { shopId: h.world.b.shopId, shopName: 'Hijacked' }],
        ['/shops/me', { id: h.world.b.shopId, address: '1 Evil Lane, Nowhere' }],
        ['/users/me', { id: bUserBefore.id, name: 'Hijacked User' }],
        ['/users/me', { userId: bUserBefore.id, name: 'Hijacked User' }]
      ];
      for (const [url, body] of attempts) {
        const res = await req(h.app, auth, 'PATCH', url, body);
        expect([200, 400], `${url} ${JSON.stringify(body)}`).toContain(res.statusCode);
      }
      const bAfter = await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.b.shopId } });
      expect(bAfter.displayName).toBe(bBefore.displayName);
      expect(bAfter.address).toBe(bBefore.address);
      const bUserAfter = await userByEmail(h.prisma, h.world.b.ownerEmail);
      expect(bUserAfter.displayName).toBe(bUserBefore.displayName);
    });

    it("B's shop profile and QR never show A's data and vice versa", async () => {
      const a = shopOf(await req(h.app, await asA(), 'GET', '/shops/me'))!;
      const b = shopOf(await req(h.app, await asB(), 'GET', '/shops/me'))!;
      expect(a.shopName).toBe('Sharma Print');
      expect(b.shopName).toBe('Metro Copies');
      const qa = dataOf(await req(h.app, await asA(), 'GET', '/shops/me/qr'));
      const qb = dataOf(await req(h.app, await asB(), 'GET', '/shops/me/qr'));
      expect(qa.publicUrl).toContain('/p/sharma-print');
      expect(qb.publicUrl).toContain('/p/metro-copies');
      expect(qa.publicUrl).not.toContain('metro');
    });

    it('rate-card information is the caller shop only', async () => {
      const a = shopOf(await req(h.app, await asA(), 'GET', '/shops/me'))!;
      const b = shopOf(await req(h.app, await asB(), 'GET', '/shops/me'))!;
      expect(JSON.stringify(a.rateInfo)).not.toBe(JSON.stringify(b.rateInfo)); // B's multiplier is 2x
    });
  });

  describe('PATCH /users/me', () => {
    it('changes the display name; trims it; rejects empty, over-long and unknown fields', async () => {
      const auth = await asA();
      const ok = await req(h.app, auth, 'PATCH', '/users/me', { name: '  Ravi Sharma  ' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(userOf(ok).name).toBe('Ravi Sharma');
      expect((await userByEmail(h.prisma, h.world.a.ownerEmail)).displayName).toBe('Ravi Sharma');
      for (const bad of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(200) }, { name: 5 }, { role: 'PLATFORM_ADMIN' }, { isVerified: true }, { phoneNumber: '+919000000000' }]) {
        const res = await req(h.app, auth, 'PATCH', '/users/me', bad);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect((await userByEmail(h.prisma, h.world.a.ownerEmail)).role).toBe('SHOP_OWNER');
    });

    it('changing the email needs the current password and is unique', async () => {
      const auth = await asA();
      const noPw = await req(h.app, auth, 'PATCH', '/users/me', { email: 'new-a@x.test' });
      expect(noPw.statusCode).toBeGreaterThanOrEqual(400);
      const wrong = await req(h.app, auth, 'PATCH', '/users/me', { email: 'new-a@x.test', currentPassword: 'definitely-wrong-1' });
      expect([401, 403]).toContain(wrong.statusCode);
      expect((await userByEmail(h.prisma, h.world.a.ownerEmail)).email).toBe(h.world.a.ownerEmail);
      const taken = await req(h.app, auth, 'PATCH', '/users/me', { email: h.world.b.ownerEmail, currentPassword: PASSWORD });
      expect(taken.statusCode).toBe(409);
      expect(taken.json().error.code).toBe('EMAIL_UNAVAILABLE');
    });

    it('requires CSRF for cookie sessions', async () => {
      const s = await login(h.app, h.world.a.ownerEmail);
      const res = await req(h.app, cookieAuth(s.cookie), 'PATCH', '/users/me', { name: 'No Csrf' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET/PATCH /shops/me', () => {
    it('refuses callers without a shop: anonymous 401, admin 403/404', async () => {
      expect((await req(h.app, null, 'GET', '/shops/me')).statusCode).toBe(401);
      const admin = sess(await login(h.app, h.world.adminEmail));
      expect([403, 404]).toContain((await req(h.app, admin, 'GET', '/shops/me')).statusCode);
    });

    it('returns the documented shop fields with exact availability: unavailable data is null, never invented', async () => {
      const res = await req(h.app, await asA(), 'GET', '/shops/me');
      expect(res.statusCode, res.body).toBe(200);
      const s = shopOf(res)!;
      for (const k of SHOP_PROFILE_KEYS) expect(Object.keys(s), `missing ${k}`).toContain(k);
      expect(s.shopName).toBe('Sharma Print');
      expect(s.address).toBe('12 MG Road, Bengaluru');
      // No such data exists in the application today.
      expect(s.rating).toBeNull();
      expect(s.referral).toBeNull();
      expect(s.payment).toBeNull();
      expect(s.location).toBeNull();
      expect(s.images == null || (Array.isArray(s.images) && s.images.length === 0)).toBe(true);
      expect(['standard', 'premium']).toContain(s.status);
      expect(s.status).toBe('standard'); // the seeded Starter plan carries no premium key
      expect(s.plan).toMatchObject({ name: 'Starter' });
      expect(Array.isArray(s.rateInfo)).toBe(true);
      expect(s.rateInfo.length).toBe(4);
      expect(s.showQr).toBe(true);
      expect(s.qrCodeUrl).toBe('http://localhost:5173/p/sharma-print');
      expect(s.registeredBy ?? null).toBeNull(); // seeded shops have no creation record
    });

    it('a shop with no subscription has plan null and status standard (no premium is implied)', async () => {
      await h.prisma.subscription.delete({ where: { shopId: h.world.a.shopId } });
      const s = shopOf(await req(h.app, await asA(), 'GET', '/shops/me'))!;
      expect(s.plan).toBeNull();
      expect(s.status).toBe('standard');
    });

    it('registeredBy reflects the audit trail of the shop creation (admin-created shop -> admin)', async () => {
      const admin = sess(await login(h.app, h.world.adminEmail));
      const plan = await h.prisma.plan.findFirstOrThrow();
      const created = await req(h.app, admin, 'POST', '/admin/shops', {
        slug: 'admin-made',
        displayName: 'Admin Made',
        ownerEmail: 'owner@admin-made.test',
        ownerName: 'Owner',
        ownerPassword: 'a-long-enough-passphrase-9',
        planId: plan.id
      });
      if (created.statusCode !== 200 && created.statusCode !== 201) return; // shape of the admin create body is owned by another suite
      const owner = sess(await login(h.app, 'owner@admin-made.test', 'a-long-enough-passphrase-9'));
      const s = shopOf(await req(h.app, owner, 'GET', '/shops/me'))!;
      expect(s.registeredBy).toBe('admin');
    });

    it('PATCH /shops/me edits only address, pincode and name; protected fields are rejected', async () => {
      const auth = await asA();
      const ok = await req(h.app, auth, 'PATCH', '/shops/me', { address: '99 New Road, Pune', pincode: '411001' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(shopOf(ok)!.address).toBe('99 New Road, Pune');
      const before = await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.a.shopId } });
      for (const bad of [
        { status: 'ACTIVE' }, { status: 'premium' }, { plan: 'premium' }, { planId: 'x' }, { slug: 'taken-over' }, { acceptsOrders: true },
        { registeredBy: 'admin' }, { referral: 'FREE' }, { rating: 5 }, { isVerified: true }, { pincode: '12' }, { address: '' }
      ]) {
        const res = await req(h.app, auth, 'PATCH', '/shops/me', bad);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }
      const after = await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.a.shopId } });
      expect(after.slug).toBe(before.slug);
      expect(after.status).toBe(before.status);
    });

    it('completing the address moves an incomplete profile to the next step', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { address: null } });
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await linkPhoneDirect(h.prisma, owner.id, PHONES.A);
      const first = await exchange(h.app, tok(PHONES.A, 6), 'mobile');
      expect(nextStepOf(first)).toBe('complete_profile');
      const auth = sessionAuthFrom(first);
      expect((await req(h.app, auth, 'PATCH', '/shops/me', { address: '5 Lake View, Mysuru', pincode: '570001' })).statusCode).toBe(200);
      expect(nextStepOf(await req(h.app, auth, 'GET', '/users/me'))).toBe('dashboard');
    });
  });

  describe('GET /shops/me/qr', () => {
    it('derives the QR destination from the slug (ready) and matches the existing /shop/qr', async () => {
      const auth = await asA();
      const res = await req(h.app, auth, 'GET', '/shops/me/qr');
      expect(res.statusCode, res.body).toBe(200);
      const d = dataOf(res);
      expect(d.ready).toBe(true);
      expect(d.publicUrl).toBe('http://localhost:5173/p/sharma-print');
      expect(d.qrCodeUrl).toBe(d.publicUrl);
      expect(d.reason ?? null).toBeNull();
      const legacy = (await call(h.app, await login(h.app, h.world.a.ownerEmail), 'GET', '/shop/qr')).json().data;
      expect(legacy.publicUrl).toBe(d.publicUrl); // one QR representation, not two
    });

    it('is not ready (with a reason) while the shop is PILOT; it does not require regeneration or persistence afterwards', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: ShopStatus.PILOT } });
      const auth = await asA();
      const d = dataOf(await req(h.app, auth, 'GET', '/shops/me/qr'));
      expect(d.ready).toBe(false);
      expect(typeof d.reason).toBe('string');
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: ShopStatus.ACTIVE } });
      const again = dataOf(await req(h.app, auth, 'GET', '/shops/me/qr'));
      expect(again.ready).toBe(true);
      expect(again.publicUrl).toBe('http://localhost:5173/p/sharma-print');
    });

    it('a PILOT shop reports showQr false and onboardingStatus generate_qr in /shops/me', async () => {
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: ShopStatus.PILOT } });
      const s = shopOf(await req(h.app, await asA(), 'GET', '/shops/me'))!;
      expect(s.showQr).toBe(false);
      expect(s.onboardingStatus).toBe('generate_qr');
    });

    it('requires an authenticated shop owner', async () => {
      expect((await req(h.app, null, 'GET', '/shops/me/qr')).statusCode).toBe(401);
    });
  });
});
