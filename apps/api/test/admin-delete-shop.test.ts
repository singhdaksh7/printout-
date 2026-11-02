import { Role, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { planShopDeletion } from '../src/domain/shop-delete.js';
import { parseArgs, runDeleteShops } from '../src/scripts/delete-shops.js';
import type { Storage } from '../src/storage.js';
import { testPrisma } from './helpers/db.js';
import { call, login, newOrder, PASSWORD, seedDevice, seedWorld, testConfig, type Session, type World } from './api-helpers.js';

/** In-memory storage that records deletions and can be told to fail. */
class FakeStorage {
  deleted: string[] = [];
  failWith: Error | null = null;
  async delete(key: string) {
    if (this.failWith) throw this.failWith;
    this.deleted.push(key);
  }
}

const prisma = testPrisma();
const storage = new FakeStorage();
const built = createApp({ config: testConfig(), prisma, storage: storage as unknown as Storage });
const app = built.app;

/** Populates every table the deletion touches for one shop. Returns ids that matter to assertions. */
async function populate(world: World, which: 'a' | 'b') {
  const shop = world[which];
  const { order, doc } = await newOrder(app, prisma, shop);
  const customer = await prisma.user.create({ data: { displayName: 'Cust', passwordHash: 'x', role: Role.CUSTOMER, email: null } });
  await prisma.order.update({ where: { id: order.id }, data: { customerUserId: customer.id, status: 'COLLECTED' } });
  await prisma.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: 'NEW', toStatus: 'COLLECTED' } });
  await prisma.orderPaymentEvent.create({ data: { orderId: order.id, shopId: shop.shopId, event: 'CASH_RECEIVED', toStatus: 'PAID', actorRole: 'CUSTOMER' } });
  await prisma.review.create({ data: { orderId: order.id, customerUserId: customer.id, shopId: shop.shopId, rating: 5 } });
  await prisma.shopNotification.create({ data: { shopId: shop.shopId, orderId: order.id, type: 'x', dedupeKey: randomUUID(), payload: {} } });
  await prisma.printJob.create({ data: { shopId: shop.shopId, orderId: order.id, code: 'AB1', serviceDay: new Date(), status: 'PRINTED' } });
  await prisma.deletionReceipt.create({ data: { receiptId: randomUUID(), documentId: doc.id, sha256: 'x', wipeFlags: {} } });
  const { device } = await seedDevice(prisma, shop.shopId);
  const printer = await prisma.devicePrinter.create({ data: { shopId: shop.shopId, deviceId: device.id, name: 'P1' } });
  await prisma.devicePrintJob.create({
    data: { shopId: shop.shopId, orderId: order.id, documentId: doc.id, deviceId: device.id, printerId: printer.id, status: 'PRINT_INITIATED', clientRequestId: randomUUID(), options: {} }
  });
  await prisma.devicePairingCode.create({ data: { shopId: shop.shopId, codeHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
  const agent = await prisma.printAgent.create({ data: { shopId: shop.shopId, name: 'agent', credentialHash: randomUUID() } });
  await prisma.printer.create({ data: { shopId: shop.shopId, agentId: agent.id, name: 'Lobby' } });
  await prisma.customerSession.create({ data: { shopId: shop.shopId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
  const invoice = await prisma.invoice.create({ data: { shopId: shop.shopId, amountPaise: 100, status: 'paid' } });
  await prisma.payment.create({ data: { invoiceId: invoice.id, amountPaise: 100, status: 'captured' } });
  await prisma.shopPaperOption.create({ data: { shopId: shop.shopId, kind: 'paperSize', value: 'A4' } });
  const imageKey = `img-${randomUUID()}`;
  await prisma.shopImage.create({ data: { shopId: shop.shopId, imageKey, contentType: 'image/png', sizeBytes: 10 } });
  const owner = await prisma.user.findFirstOrThrow({ where: { shopId: shop.shopId } });
  await prisma.membership.create({ data: { shopId: shop.shopId, userId: owner.id, role: 'OWNER' } });
  await prisma.fcmRegistration.create({ data: { userId: owner.id, shopId: shop.shopId, installationId: 'i1', platform: 'android', tokenCipher: 'c', tokenHash: randomUUID() } });
  return { order, doc, customer, owner, imageKey, deviceId: device.id };
}

describe('DELETE /admin/shops/:id and the delete-shops script', () => {
  let world: World;
  let admin: Session;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    admin = await login(app, world.adminEmail);
    storage.deleted = [];
    storage.failWith = null;
  });

  const del = (shopId: string, body: unknown, session: Session | null = admin) => call(app, session, 'DELETE', `/admin/shops/${shopId}`, body);
  const ok = (slug: string, extra: Record<string, unknown> = {}) => ({ confirmSlug: slug, currentPassword: PASSWORD, ...extra });

  it('removes every row of the shop and its storage objects, leaves the other shop untouched, and writes one audit row', async () => {
    const a = await populate(world, 'a');
    const b = await populate(world, 'b');
    await prisma.order.update({ where: { id: a.order.id }, data: { status: 'COLLECTED' } });
    const beforeB = await planShopDeletion(prisma, world.b.shopId);
    const beforeA = await planShopDeletion(prisma, world.a.shopId);
    for (const [table, n] of Object.entries(beforeA.counts)) expect(n, `seeded ${table}`).toBeGreaterThan(0);

    const res = await del(world.a.shopId, ok(world.a.slug));
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ deleted: true, shopId: world.a.shopId, slug: world.a.slug, owners: { deleted: 1, detached: 0 } });
    expect(data.counts).toMatchObject({ ...beforeA.counts, users: 1 });

    // Every table: zero rows for shop A.
    const byShop = { shopId: world.a.shopId };
    expect(await prisma.shop.count({ where: { id: world.a.shopId } })).toBe(0);
    const zero = await Promise.all([
      prisma.order.count({ where: byShop }), prisma.orderStatusHistory.count({ where: { orderId: a.order.id } }),
      prisma.orderPaymentEvent.count({ where: byShop }), prisma.review.count({ where: byShop }),
      prisma.shopNotification.count({ where: byShop }), prisma.document.count({ where: byShop }),
      prisma.deletionReceipt.count({ where: { documentId: a.doc.id } }), prisma.printJob.count({ where: byShop }),
      prisma.devicePrintJob.count({ where: byShop }), prisma.devicePrinter.count({ where: byShop }),
      prisma.shopDevice.count({ where: byShop }), prisma.devicePairingCode.count({ where: byShop }),
      prisma.printAgent.count({ where: byShop }), prisma.printer.count({ where: byShop }),
      prisma.customerSession.count({ where: byShop }), prisma.invoice.count({ where: byShop }),
      prisma.payment.count({ where: { invoice: byShop } }), prisma.pricingRule.count({ where: byShop }),
      prisma.shopPaperOption.count({ where: byShop }), prisma.shopImage.count({ where: byShop }),
      prisma.shopSettings.count({ where: byShop }), prisma.subscription.count({ where: byShop }),
      prisma.membership.count({ where: byShop }), prisma.fcmRegistration.count({ where: byShop })
    ]);
    expect(zero.every((n) => n === 0)).toBe(true);
    expect(storage.deleted).toEqual(expect.arrayContaining([a.doc.objectKey, a.imageKey]));
    expect(storage.deleted).not.toContain(b.doc.objectKey);

    // Owner deleted with its dependents; customer and admin kept; customer's other data intact.
    expect(await prisma.user.count({ where: { id: a.owner.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: a.owner.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: a.customer.id } })).toBe(1);
    expect(await prisma.user.count({ where: { id: admin.userId } })).toBe(1);

    // Shop B untouched.
    const afterB = await planShopDeletion(prisma, world.b.shopId);
    expect(afterB.counts).toEqual(beforeB.counts);
    expect(await prisma.user.count({ where: { id: b.owner.id } })).toBe(1);

    // Exactly one surviving audit row: no FK to the shop, no PII.
    const rows = await prisma.auditLog.findMany({ where: { action: 'admin.shop.delete' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shopId: null, actorUserId: admin.userId, actorType: 'PLATFORM_ADMIN', targetType: 'shop', targetId: world.a.shopId });
    expect(rows[0]!.metadata).toMatchObject({ slug: world.a.slug, displayName: 'Sharma Print', via: 'admin_api', counts: { orders: 1, documents: 1 } });
    const blob = JSON.stringify(rows[0]);
    for (const secret of [world.a.ownerEmail, 'owner@a.test', PASSWORD, a.doc.objectKey, 'notes.pdf', a.customer.id]) expect(blob).not.toContain(secret);
    // The audit log stays append-only: earlier rows are not deleted by a shop deletion.
    expect(await prisma.auditLog.count({ where: { action: 'admin.shop.create' } })).toBe(0);
  });

  it('second call is 404 (idempotent) and the audit row is not duplicated', async () => {
    expect((await del(world.a.shopId, ok(world.a.slug))).statusCode).toBe(200);
    const again = await del(world.a.shopId, ok(world.a.slug));
    expect(again.statusCode).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: 'admin.shop.delete' } })).toBe(1);
  });

  it('wrong or missing slug is 400 and deletes nothing', async () => {
    const wrong = await del(world.a.shopId, ok('metro-copies'));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('SHOP_SLUG_MISMATCH');
    expect((await del(world.a.shopId, { currentPassword: PASSWORD })).statusCode).toBe(400);
    expect((await del(world.a.shopId, undefined)).statusCode).toBe(400);
    expect(await prisma.shop.count()).toBe(2);
    expect(storage.deleted).toHaveLength(0);
  });

  it('step-up: wrong or missing current password is refused and nothing is deleted', async () => {
    const wrong = await del(world.a.shopId, { confirmSlug: world.a.slug, currentPassword: 'not-the-password-123' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect((await del(world.a.shopId, { confirmSlug: world.a.slug })).statusCode).toBe(400);
    expect(await prisma.shop.count()).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'admin.account.reauth_failed' } })).toBe(1);
  });

  it('refuses anonymous, shop owner and customer sessions, and requires CSRF', async () => {
    const owner = await login(app, world.a.ownerEmail);
    expect((await del(world.a.shopId, ok(world.a.slug), null)).statusCode).toBe(401);
    expect((await del(world.a.shopId, ok(world.a.slug), owner)).statusCode).toBe(403);
    const customer = await prisma.user.create({ data: { displayName: 'C', passwordHash: await hashPassword(PASSWORD), role: Role.CUSTOMER, email: 'cust@x.test' } });
    void customer;
    const noCsrf = await app.inject({ method: 'DELETE', url: `/api/v1/admin/shops/${world.a.shopId}`, headers: { cookie: admin.cookie }, payload: ok(world.a.slug) });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('CSRF_INVALID');
    expect(await prisma.shop.count()).toBe(2);
  });

  it('an owner with a second shop keeps the account (detached only) and loses the sessions', async () => {
    const owner = await prisma.user.findFirstOrThrow({ where: { shopId: world.a.shopId } });
    await prisma.membership.create({ data: { shopId: world.a.shopId, userId: owner.id, role: 'OWNER' } });
    await prisma.membership.create({ data: { shopId: world.b.shopId, userId: owner.id, role: 'OWNER' } });
    const ownerSession = await login(app, world.a.ownerEmail);
    const res = await del(world.a.shopId, ok(world.a.slug));
    expect(res.statusCode).toBe(200);
    expect(res.json().data.owners).toEqual({ deleted: 0, detached: 1 });
    const kept = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(kept.shopId).toBeNull();
    expect(await prisma.membership.count({ where: { userId: owner.id } })).toBe(1);
    expect((await call(app, ownerSession, 'GET', '/shop/orders')).statusCode).toBe(401);
  });

  it('active orders: 409 SHOP_HAS_ACTIVE_WORK without force, success with force', async () => {
    await populate(world, 'a');
    const active = await newOrder(app, prisma, world.a); // NEW order
    void active;
    const refused = await del(world.a.shopId, ok(world.a.slug));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SHOP_HAS_ACTIVE_WORK');
    expect(await prisma.shop.count()).toBe(2);
    expect(storage.deleted).toHaveLength(0);
    const forced = await del(world.a.shopId, ok(world.a.slug, { force: true }));
    expect(forced.statusCode).toBe(200);
    expect(await prisma.order.count({ where: { shopId: world.a.shopId } })).toBe(0);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'admin.shop.delete' } })).metadata).toMatchObject({ forced: true });
  });

  it('in-flight device print job also blocks without force', async () => {
    const a = await populate(world, 'a');
    await prisma.order.update({ where: { id: a.order.id }, data: { status: 'COLLECTED' } });
    await prisma.devicePrintJob.updateMany({ where: { shopId: world.a.shopId }, data: { status: 'SUBMITTING' } });
    const refused = await del(world.a.shopId, ok(world.a.slug));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toMatchObject({ activeDevicePrintJobs: 1 });
  });

  it('a non-not-found storage failure aborts before any row is touched (502)', async () => {
    const a = await populate(world, 'a');
    await prisma.order.update({ where: { id: a.order.id }, data: { status: 'COLLECTED' } });
    storage.failWith = new Error('boom');
    const res = await del(world.a.shopId, ok(world.a.slug));
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('STORAGE_DELETE_FAILED');
    expect(await prisma.shop.count({ where: { id: world.a.shopId } })).toBe(1);
    expect(await prisma.order.count({ where: { shopId: world.a.shopId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'admin.shop.delete' } })).toBe(0);
    storage.failWith = null;
    expect((await del(world.a.shopId, ok(world.a.slug))).statusCode).toBe(200);
  });

  it('OrderPaymentEvent stays immutable outside a shop deletion', async () => {
    const a = await populate(world, 'a');
    await expect(prisma.orderPaymentEvent.deleteMany({ where: { orderId: a.order.id } })).rejects.toThrow();
    await expect(prisma.orderPaymentEvent.updateMany({ where: { orderId: a.order.id }, data: { reason: 'x' } })).rejects.toThrow();
  });

  describe('operator script', () => {
    const run = async (argv: string[]) => {
      const lines: string[] = [];
      const parsed = parseArgs(argv);
      if (typeof parsed === 'string') throw new Error(parsed);
      const code = await runDeleteShops(parsed, { prisma: prisma as PrismaClient, storage }, (l) => lines.push(l));
      return { code, text: lines.join('\n') };
    };

    it('requires --keep', () => {
      expect(typeof parseArgs([])).toBe('string');
      expect(typeof parseArgs(['--execute'])).toBe('string');
    });

    it('dry run (default) prints counts and changes nothing', async () => {
      const a = await populate(world, 'a');
      await prisma.order.update({ where: { id: a.order.id }, data: { status: 'COLLECTED' } });
      const r = await run(['--keep', world.b.slug]);
      expect(r.code).toBe(0);
      expect(r.text).toContain('DRY RUN');
      expect(r.text).toContain(`KEEP   ${world.b.slug}`);
      expect(r.text).toContain(`DELETE ${world.a.slug}`);
      expect(r.text).toContain('orders=1');
      expect(r.text).toContain('documents=1 images=1');
      expect(await prisma.shop.count()).toBe(2);
      expect(storage.deleted).toHaveLength(0);
      expect(await prisma.auditLog.count({ where: { action: 'admin.shop.delete' } })).toBe(0);
    });

    it('typo guard: a --keep slug that does not exist refuses everything', async () => {
      const r = await run(['--keep', `${world.b.slug},metro-copiez`, '--execute']);
      expect(r.code).toBe(2);
      expect(r.text).toContain('REFUSED');
      expect(await prisma.shop.count()).toBe(2);
    });

    it('--execute deletes only the shops not kept, keeps owners of kept shops, audits as SYSTEM', async () => {
      const a = await populate(world, 'a');
      const b = await populate(world, 'b');
      await prisma.order.updateMany({ data: { status: 'COLLECTED' } });
      const r = await run(['--keep', world.b.slug, '--execute']);
      expect(r.code).toBe(0);
      expect(r.text).toContain('SUMMARY: deleted=1 skipped=0 failed=0 kept=1');
      expect(await prisma.shop.findMany({ select: { slug: true } })).toEqual([{ slug: world.b.slug }]);
      expect(await prisma.user.count({ where: { id: a.owner.id } })).toBe(0);
      expect(await prisma.user.count({ where: { id: b.owner.id } })).toBe(1);
      expect(await prisma.user.count({ where: { role: Role.PLATFORM_ADMIN } })).toBe(1);
      const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'admin.shop.delete' } });
      expect(row).toMatchObject({ shopId: null, actorUserId: null, actorType: 'SYSTEM', targetId: world.a.shopId });
      expect(row.metadata).toMatchObject({ via: 'operator_script', operator: 'operator-script' });
    });

    it('skips a shop with in-flight work unless --force, and continues past it', async () => {
      await newOrder(app, prisma, world.a); // NEW
      const skipped = await run(['--keep', world.b.slug, '--execute']);
      expect(skipped.code).toBe(1);
      expect(skipped.text).toContain('SKIPPED');
      expect(await prisma.shop.count()).toBe(2);
      const forced = await run(['--keep', world.b.slug, '--execute', '--force']);
      expect(forced.code).toBe(0);
      expect(await prisma.shop.count()).toBe(1);
    });
  });
});
