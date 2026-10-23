import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenHash } from '../src/auth.js';
import { sweepFcm } from '../src/notifications/fcm-registrations.js';
import { PERMANENT_FCM_ERRORS } from '../src/notifications/fcm.js';
import { login, newOrder } from './api-helpers.js';
import { cookieAuth, FakePushSender, makeShopReady, req, sleep, startHarness, userByEmail, type Auth, type Harness } from './helpers/profile-harness.js';

const A1 = 'fcm-A-phone-1-0123456789-abcdefghijklmnopqrstuvwxyz';
const A2 = 'fcm-A-phone-2-0123456789-abcdefghijklmnopqrstuvwxyz';
const B1 = 'fcm-B-phone-1-0123456789-abcdefghijklmnopqrstuvwxyz';
const INST = (n: string) => `installation-${n}-0000000000`;

describe('push notifications for new orders (FakePushSender, no real FCM)', () => {
  const sender = new FakePushSender();
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ FCM_PUSH_ENABLED: 'true', FCM_FAILURE_REVOKE_AFTER: '2' }, undefined, { pushSender: sender });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    sender.reset();
    await makeShopReady(h.prisma, h.world.a.shopId);
    await makeShopReady(h.prisma, h.world.b.shopId);
  });

  const sessionAs = async (email: string): Promise<Auth> => {
    const s = await login(h.app, email);
    return cookieAuth(s.cookie, s.csrf);
  };
  const register = async (email: string, installationId: string, token: string) => {
    const res = await req(h.app, await sessionAs(email), 'PUT', '/users/me/fcm-token', { installationId, token, platform: 'android' });
    expect(res.statusCode, res.body).toBe(200);
  };
  const shopA = () => ({ shopId: h.world.a.shopId, slug: h.world.a.slug });
  const shopB = () => ({ shopId: h.world.b.shopId, slug: h.world.b.slug });
  const reg = (token: string) => h.prisma.fcmRegistration.findFirstOrThrow({ where: { OR: [{ tokenHash: tokenHash(token) }, { tokenHash: { startsWith: 'revoked:' } }] }, orderBy: { updatedAt: 'desc' } });
  const regByInstall = (installationId: string) => h.prisma.fcmRegistration.findFirstOrThrow({ where: { installationId } });
  /** Push is fire-and-forget after the order commits: wait for the sender, then give stragglers a moment. */
  const settled = async (calls: number) => {
    await vi.waitFor(() => expect(sender.calls.length).toBe(calls), { timeout: 5000, interval: 25 });
    await sleep(150);
    expect(sender.calls.length).toBe(calls);
  };
  const quiet = async () => {
    await sleep(500);
    expect(sender.calls.length).toBe(0);
  };

  describe('delivery', () => {
    it('a new order at shop A pushes once, to A’s registered tokens only, with a minimal payload', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      await register(h.world.a.ownerEmail, INST('a2'), A2);
      const { order } = await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      const [call] = sender.calls;
      expect([...call!.tokens].sort()).toEqual([A1, A2].sort());
      expect(call!.message).toEqual({ type: 'order.new', orderId: order.id, title: 'New print order' });
    });

    it('the payload carries no personal data, file names, URLs, tracking tokens or prices', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      const { order, trackingToken } = await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      const message = sender.calls[0]!.message;
      expect(Object.keys(message).sort()).toEqual(['orderId', 'title', 'type']);
      const blob = JSON.stringify(message);
      for (const leak of ['notes.pdf', '.pdf', 'http', 'localhost', trackingToken, 'documentId', 'objectKey', 'phone', '@', 'paise', 'price']) {
        expect(blob.toLowerCase().includes(leak.toLowerCase()), `payload contains ${leak}`).toBe(false);
      }
      expect(message.orderId).toBe(order.id);
    });

    it('tenant isolation: a shop A order never reaches B’s registrations, and a B order never reaches A’s', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      await register(h.world.b.ownerEmail, INST('b1'), B1);
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      expect(sender.allTokens).toEqual([A1]);
      sender.reset();
      await newOrder(h.app, h.prisma, shopB());
      await settled(1);
      expect(sender.allTokens).toEqual([B1]);
    });

    it('a registration does not follow its user to another shop: an owner who no longer belongs to the shop gets nothing', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
      await h.prisma.user.update({ where: { id: owner.id }, data: { shopId: null } });
      await newOrder(h.app, h.prisma, shopA());
      await quiet();
    });

    it('an owner whose role changed away from SHOP_OWNER gets nothing', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      await h.prisma.user.update({ where: { email: h.world.a.ownerEmail }, data: { role: 'PLATFORM_ADMIN' } });
      await newOrder(h.app, h.prisma, shopA());
      await quiet();
    });

    it('nothing is sent when no one registered, and the order still succeeds', async () => {
      const { order } = await newOrder(h.app, h.prisma, shopA());
      expect(order.id).toBeTruthy();
      await quiet();
    });

    it('revoked (removed / logged-out) registrations are not used', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      await register(h.world.a.ownerEmail, INST('a2'), A2);
      const auth = await sessionAs(h.world.a.ownerEmail);
      expect((await req(h.app, auth, 'DELETE', '/users/me/fcm-token', { installationId: INST('a1') })).statusCode).toBe(204);
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      expect(sender.allTokens).toEqual([A2]);
    });

    it('never pushes the full token set of a shop that has none for the order’s shop even if other shops have many', async () => {
      await register(h.world.b.ownerEmail, INST('b1'), B1);
      await newOrder(h.app, h.prisma, shopA());
      await quiet();
    });
  });

  describe('switches', () => {
    it('FCM_PUSH_ENABLED=false (the default) sends nothing even when a sender is wired', async () => {
      const off = new FakePushSender();
      const o = await startHarness({ FCM_PUSH_ENABLED: 'false' }, undefined, { pushSender: off });
      try {
        await makeShopReady(o.prisma, o.world.a.shopId);
        const s = await login(o.app, o.world.a.ownerEmail);
        expect((await req(o.app, cookieAuth(s.cookie, s.csrf), 'PUT', '/users/me/fcm-token', { installationId: INST('a1'), token: A1, platform: 'android' })).statusCode).toBe(200);
        await newOrder(o.app, o.prisma, { shopId: o.world.a.shopId, slug: o.world.a.slug });
        await sleep(500);
        expect(off.calls).toHaveLength(0);
      } finally {
        await o.close();
      }
    });

    it('with no sender at all (null) orders are unaffected', async () => {
      const none = await startHarness({ FCM_PUSH_ENABLED: 'true' }, undefined, { pushSender: null });
      try {
        const { order } = await newOrder(none.app, none.prisma, { shopId: none.world.a.shopId, slug: none.world.a.slug });
        expect(order.id).toBeTruthy();
      } finally {
        await none.close();
      }
    });
  });

  describe('failures never break order placement', () => {
    it('a sender that throws does not affect the order or its response', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      sender.throwAll = true;
      const { order, quote } = await newOrder(h.app, h.prisma, shopA());
      expect(order.id).toBeTruthy();
      expect(quote).toBeTruthy();
      await vi.waitFor(() => expect(sender.calls.length).toBe(1));
      expect(await h.prisma.order.count({ where: { shopId: h.world.a.shopId } })).toBe(1);
      // a thrown (whole-batch) failure is not an invalid token: the registration stays
      expect((await regByInstall(INST('a1'))).enabled).toBe(true);
    });

    it('the order notification (durable outbox + SSE feed) is unchanged whether push works or not', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      sender.throwAll = true;
      const { order } = await newOrder(h.app, h.prisma, shopA());
      const auth = await sessionAs(h.world.a.ownerEmail);
      const list = await req(h.app, auth, 'GET', '/shop/notifications');
      expect(list.statusCode, list.body).toBe(200);
      expect(list.body).toContain(order.id);
      expect(list.body).not.toContain(A1);
    });

    it('transient per-token failures count up and the registration is revoked after FCM_FAILURE_REVOKE_AFTER (2) consecutive ones', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      sender.failWith.set(A1, 'messaging/internal-error');
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      await vi.waitFor(async () => expect((await regByInstall(INST('a1'))).failureCount).toBe(1));
      expect((await regByInstall(INST('a1'))).enabled).toBe(true);
      await newOrder(h.app, h.prisma, shopA());
      await settled(2);
      await vi.waitFor(async () => expect((await regByInstall(INST('a1'))).enabled).toBe(false));
    });

    it('a success resets the failure counter and records lastSuccessAt', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      sender.failWith.set(A1, 'messaging/internal-error');
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      await vi.waitFor(async () => expect((await regByInstall(INST('a1'))).failureCount).toBe(1));
      sender.failWith.clear();
      await newOrder(h.app, h.prisma, shopA());
      await settled(2);
      await vi.waitFor(async () => {
        const r = await regByInstall(INST('a1'));
        expect(r.failureCount).toBe(0);
        expect(r.lastSuccessAt).toBeInstanceOf(Date);
      });
    });
  });

  describe('invalid-token cleanup', () => {
    it.each([...PERMANENT_FCM_ERRORS])('%s revokes that registration immediately and keeps the others', async (code) => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      await register(h.world.a.ownerEmail, INST('a2'), A2);
      sender.failWith.set(A1, code);
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      await vi.waitFor(async () => expect((await regByInstall(INST('a1'))).enabled).toBe(false));
      const dead = await regByInstall(INST('a1'));
      expect(dead.revokedAt).toBeInstanceOf(Date);
      expect(dead.tokenCipher).toBe('');
      expect(dead.tokenHash.startsWith('revoked:')).toBe(true);
      expect((await regByInstall(INST('a2'))).enabled).toBe(true);
      sender.reset();
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      expect(sender.allTokens).toEqual([A2]); // the dead token is never tried again
    });

    it('a dead token can be registered again by its holder after revocation', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      sender.failWith.set(A1, 'messaging/registration-token-not-registered');
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      await vi.waitFor(async () => expect((await regByInstall(INST('a1'))).enabled).toBe(false));
      sender.reset();
      await register(h.world.a.ownerEmail, INST('a1'), A2);
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      expect(sender.allTokens).toEqual([A2]);
    });
  });

  describe('stale cleanup', () => {
    it('a registration the app stopped refreshing (older than FCM_STALE_DAYS) is skipped for delivery', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      await register(h.world.a.ownerEmail, INST('a2'), A2);
      await h.prisma.fcmRegistration.updateMany({ where: { installationId: INST('a1') }, data: { lastRegisteredAt: new Date(Date.now() - 61 * 86_400_000) } });
      await newOrder(h.app, h.prisma, shopA());
      await settled(1);
      expect(sender.allTokens).toEqual([A2]);
    });

    it('sweepFcm deletes stale and long-revoked rows and keeps live ones', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      await register(h.world.a.ownerEmail, INST('a2'), A2);
      await register(h.world.b.ownerEmail, INST('b1'), B1);
      const auth = await sessionAs(h.world.a.ownerEmail);
      await req(h.app, auth, 'DELETE', '/users/me/fcm-token', { installationId: INST('a2') });
      await h.prisma.fcmRegistration.updateMany({ where: { installationId: INST('a1') }, data: { lastRegisteredAt: new Date(Date.now() - 90 * 86_400_000) } }); // stale
      await h.prisma.fcmRegistration.updateMany({ where: { installationId: INST('a2') }, data: { revokedAt: new Date(Date.now() - 40 * 86_400_000) } }); // revoked long ago
      const res = await sweepFcm(h.prisma, 60);
      expect(res.deleted).toBe(2);
      const left = await h.prisma.fcmRegistration.findMany();
      expect(left.map((r) => r.installationId)).toEqual([INST('b1')]);
    });

    it('a freshly revoked row is kept for a while (not swept yet)', async () => {
      await register(h.world.a.ownerEmail, INST('a1'), A1);
      const auth = await sessionAuthLike();
      await req(h.app, auth, 'DELETE', '/users/me/fcm-token', { installationId: INST('a1') });
      expect((await sweepFcm(h.prisma, 60)).deleted).toBe(0);
    });
  });

  async function sessionAuthLike() {
    return sessionAs(h.world.a.ownerEmail);
  }

  it('push registrations and deliveries never put tokens into audit rows or HTTP bodies', async () => {
    await register(h.world.a.ownerEmail, INST('a1'), A1);
    sender.failWith.set(A1, 'messaging/registration-token-not-registered');
    await newOrder(h.app, h.prisma, shopA());
    await settled(1);
    const blob = JSON.stringify({ audit: await h.prisma.auditLog.findMany(), notifications: await h.prisma.shopNotification.findMany() }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(blob.includes(A1)).toBe(false);
  });
});
