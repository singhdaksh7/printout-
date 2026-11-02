import { DevicePrintJobStatus, OrderStatus, PrintJobStatus, Role, type Prisma, type PrismaClient } from '@prisma/client';
import { AppError, notFound } from '../errors.js';
import type { ShopEvents } from '../events.js';
import type { ShopNotificationHub } from '../notifications/shop-notifications.js';
import type { Storage } from '../storage.js';
import { audit } from '../routes/context.js';

/**
 * Permanent, complete removal of one shop (the admin API and the operator script share this function).
 *
 * Sequence: plan (read only), refuse on in-flight work unless forced, storage objects (documents, shop images; a missing
 * object is fine, any other failure aborts BEFORE any row is touched), then ONE transaction (shop row locked, explicit
 * deletes in dependency order, owner-account rule, one surviving audit row), then close live streams.
 *
 * Owner accounts: a SHOP_OWNER user tied to the shop is deleted only if, after the shop's rows are gone, it has no other
 * shop or membership, no customer orders or reviews elsewhere, no non-owner role grant, and is not in `protectedUserIds`.
 * Otherwise it is detached only. Sessions and refresh tokens of everyone tied to the shop end either way.
 * Admins and customers are never deleted.
 */

export interface ShopDeleteContext {
  prisma: PrismaClient;
  storage: Pick<Storage, 'delete'>;
  events?: Pick<ShopEvents, 'closeShop'>;
  notifications?: Pick<ShopNotificationHub, 'closeShop'>;
}

export type ShopDeleteActor = { type: 'PLATFORM_ADMIN'; userId: string } | { type: 'SYSTEM'; marker: string };

export interface ShopDeleteOptions {
  actor: ShopDeleteActor;
  /** Proceed even though orders are NEW/ACCEPTED/PRINTING or a print job is in flight. */
  force?: boolean;
  /** Users that must never be deleted (the script passes the owners of the shops it keeps). */
  protectedUserIds?: readonly string[];
  via: 'admin_api' | 'operator_script';
  log?: { warn?: (obj: Record<string, unknown>, msg?: string) => void };
}

export type DeleteCounts = Record<string, number>;

export interface ShopDeletionPlan {
  shop: { id: string; slug: string; displayName: string; status: string };
  counts: DeleteCounts;
  storageObjects: { documents: number; images: number };
  activeWork: { activeOrders: number; activeDevicePrintJobs: number; activePrintJobs: number };
}

export interface ShopDeletionResult {
  shopId: string;
  slug: string;
  displayName: string;
  counts: DeleteCounts;
  storageObjects: { documents: number; images: number };
  owners: { deleted: number; detached: number };
  /** Objects created while the deletion ran that could not be removed afterwards (expected 0). */
  orphanedObjects: number;
}

const ACTIVE_ORDER: OrderStatus[] = [OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PRINTING];
const ACTIVE_DEVICE_JOB: DevicePrintJobStatus[] = [
  DevicePrintJobStatus.QUEUED,
  DevicePrintJobStatus.CLAIMED,
  DevicePrintJobStatus.DOWNLOADING,
  DevicePrintJobStatus.SUBMITTING,
  DevicePrintJobStatus.SUBMITTED_TO_SPOOLER,
  DevicePrintJobStatus.CANCEL_REQUESTED
];
const ACTIVE_PRINT_JOB: PrintJobStatus[] = [PrintJobStatus.QUEUED, PrintJobStatus.PRINTING];

type Db = PrismaClient | Prisma.TransactionClient;

async function activeWork(db: Db, shopId: string) {
  const [activeOrders, activeDevicePrintJobs, activePrintJobs] = await Promise.all([
    db.order.count({ where: { shopId, status: { in: ACTIVE_ORDER } } }),
    db.devicePrintJob.count({ where: { shopId, status: { in: ACTIVE_DEVICE_JOB } } }),
    db.printJob.count({ where: { shopId, status: { in: ACTIVE_PRINT_JOB } } })
  ]);
  return { activeOrders, activeDevicePrintJobs, activePrintJobs };
}

async function storageKeys(db: Db, shopId: string) {
  const [docs, images] = await Promise.all([
    // DELETED documents were verified gone by retention; everything else may still own an object.
    db.document.findMany({ where: { shopId, status: { not: 'DELETED' } }, select: { objectKey: true } }),
    db.shopImage.findMany({ where: { shopId }, select: { imageKey: true } })
  ]);
  return { documents: docs.map((d) => d.objectKey), images: images.map((i) => i.imageKey) };
}

/** Row counts per table that deleting the shop would remove (read only). Throws 404 when the shop does not exist. */
export async function planShopDeletion(db: Db, shopId: string): Promise<ShopDeletionPlan> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true, slug: true, displayName: true, status: true } });
  if (!shop) throw notFound('Shop not found');
  const byShop = { shopId };
  const [orders, orderStatusHistory, orderPaymentEvents, reviews, shopNotifications, documents, deletionReceipts, printJobs, devicePrintJobs, invoices, payments, pricingRules, paperOptions, images, settings, subscriptions, memberships, devices, devicePrinters, pairingCodes, printAgents, printers, customerSessions, fcmRegistrations, work, keys] =
    await Promise.all([
      db.order.count({ where: byShop }),
      db.orderStatusHistory.count({ where: { order: byShop } }),
      db.orderPaymentEvent.count({ where: byShop }),
      db.review.count({ where: byShop }),
      db.shopNotification.count({ where: byShop }),
      db.document.count({ where: byShop }),
      db.deletionReceipt.count({ where: { document: byShop } }),
      db.printJob.count({ where: byShop }),
      db.devicePrintJob.count({ where: byShop }),
      db.invoice.count({ where: byShop }),
      db.payment.count({ where: { invoice: byShop } }),
      db.pricingRule.count({ where: byShop }),
      db.shopPaperOption.count({ where: byShop }),
      db.shopImage.count({ where: byShop }),
      db.shopSettings.count({ where: byShop }),
      db.subscription.count({ where: byShop }),
      db.membership.count({ where: byShop }),
      db.shopDevice.count({ where: byShop }),
      db.devicePrinter.count({ where: byShop }),
      db.devicePairingCode.count({ where: byShop }),
      db.printAgent.count({ where: byShop }),
      db.printer.count({ where: byShop }),
      db.customerSession.count({ where: byShop }),
      db.fcmRegistration.count({ where: byShop }),
      activeWork(db, shopId),
      storageKeys(db, shopId)
    ]);
  return {
    shop,
    counts: {
      orders, orderStatusHistory, orderPaymentEvents, reviews, shopNotifications, documents, deletionReceipts, printJobs, devicePrintJobs,
      invoices, payments, pricingRules, paperOptions, images, settings, subscriptions, memberships, devices, devicePrinters,
      pairingCodes, printAgents, printers, customerSessions, fcmRegistrations
    },
    storageObjects: { documents: keys.documents.length, images: keys.images.length },
    activeWork: work
  };
}

export const hasActiveWork = (w: ShopDeletionPlan['activeWork']) => w.activeOrders + w.activeDevicePrintJobs + w.activePrintJobs > 0;

function activeWorkError(w: ShopDeletionPlan['activeWork']) {
  return new AppError(409, 'SHOP_HAS_ACTIVE_WORK', 'This shop has orders or print jobs in progress. Confirm again with force to delete it anyway.', { ...w });
}

async function deleteObjects(ctx: ShopDeleteContext, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await ctx.storage.delete(key); // idempotent: a missing object is success
    } catch {
      throw new AppError(502, 'STORAGE_DELETE_FAILED', 'Stored files could not be deleted. Nothing was removed from the database; try again.');
    }
  }
}

export async function deleteShopCompletely(ctx: ShopDeleteContext, shopId: string, opts: ShopDeleteOptions): Promise<ShopDeletionResult> {
  const { prisma } = ctx;
  const plan = await planShopDeletion(prisma, shopId);
  if (hasActiveWork(plan.activeWork) && !opts.force) throw activeWorkError(plan.activeWork);

  const keys = await storageKeys(prisma, shopId);
  const known = new Set([...keys.documents, ...keys.images]);
  await deleteObjects(ctx, [...keys.documents, ...keys.images]);

  const { result, leftovers } = await prisma.$transaction(
    async (tx) => {
      // Row lock: order creation locks the shop too, so nothing new can be added while this runs.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Shop" WHERE "id" = ${shopId} FOR UPDATE`;
      if (locked.length === 0) throw notFound('Shop not found');
      const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
      const work = await activeWork(tx, shopId);
      if (hasActiveWork(work) && !opts.force) throw activeWorkError(work);

      const late = await storageKeys(tx, shopId);
      const leftovers = [...late.documents, ...late.images].filter((k) => !known.has(k));

      // Payment events are append-only evidence; only this transaction may remove them (see migration 20261102120000).
      await tx.$executeRaw`SELECT set_config('app.shop_delete', 'on', true)`;

      const candidates = await tx.user.findMany({
        where: { OR: [{ shopId }, { memberships: { some: { shopId } } }] },
        select: { id: true }
      });
      const candidateIds = candidates.map((u) => u.id);
      // Live sessions and mobile refresh tokens of everyone tied to the shop end now (deleted accounts lose them by cascade as well).
      const now = new Date();
      await tx.session.updateMany({ where: { userId: { in: candidateIds }, invalidatedAt: null }, data: { invalidatedAt: now } });
      await tx.refreshToken.updateMany({ where: { userId: { in: candidateIds }, revokedAt: null }, data: { revokedAt: now, revokedReason: 'shop_deleted' } });

      const byShop = { shopId };
      const counts: DeleteCounts = {};
      counts.orderStatusHistory = (await tx.orderStatusHistory.deleteMany({ where: { order: byShop } })).count;
      counts.orderPaymentEvents = (await tx.orderPaymentEvent.deleteMany({ where: byShop })).count;
      counts.reviews = (await tx.review.deleteMany({ where: byShop })).count;
      counts.shopNotifications = (await tx.shopNotification.deleteMany({ where: byShop })).count;
      counts.devicePrintJobs = (await tx.devicePrintJob.deleteMany({ where: byShop })).count;
      counts.printJobs = (await tx.printJob.deleteMany({ where: byShop })).count;
      counts.orders = (await tx.order.deleteMany({ where: byShop })).count;
      counts.deletionReceipts = (await tx.deletionReceipt.deleteMany({ where: { document: byShop } })).count;
      counts.documents = (await tx.document.deleteMany({ where: byShop })).count;
      counts.payments = (await tx.payment.deleteMany({ where: { invoice: byShop } })).count;
      counts.invoices = (await tx.invoice.deleteMany({ where: byShop })).count;
      counts.pricingRules = (await tx.pricingRule.deleteMany({ where: byShop })).count;
      counts.paperOptions = (await tx.shopPaperOption.deleteMany({ where: byShop })).count;
      counts.images = (await tx.shopImage.deleteMany({ where: byShop })).count;
      counts.settings = (await tx.shopSettings.deleteMany({ where: byShop })).count;
      counts.subscriptions = (await tx.subscription.deleteMany({ where: byShop })).count;
      counts.memberships = (await tx.membership.deleteMany({ where: byShop })).count;
      counts.devicePrinters = (await tx.devicePrinter.deleteMany({ where: byShop })).count;
      counts.devices = (await tx.shopDevice.deleteMany({ where: byShop })).count;
      counts.pairingCodes = (await tx.devicePairingCode.deleteMany({ where: byShop })).count;
      counts.printers = (await tx.printer.deleteMany({ where: byShop })).count;
      counts.printAgents = (await tx.printAgent.deleteMany({ where: byShop })).count;
      counts.customerSessions = (await tx.customerSession.deleteMany({ where: byShop })).count;
      counts.fcmRegistrations = (await tx.fcmRegistration.deleteMany({ where: byShop })).count;
      await tx.shop.delete({ where: { id: shopId } }); // User.shopId becomes NULL; older audit rows keep their text but lose the FK

      // Owner-account rule, evaluated after the shop's rows are gone so "other shop" means a different shop.
      const protectedIds = new Set(opts.protectedUserIds ?? []);
      const eligible = await tx.user.findMany({
        where: {
          id: { in: candidateIds.filter((id) => !protectedIds.has(id)) },
          role: Role.SHOP_OWNER,
          shopId: null,
          memberships: { none: {} },
          customerOrders: { none: {} },
          reviews: { none: {} },
          roleGrants: { none: { role: { not: Role.SHOP_OWNER } } }
        },
        select: { id: true }
      });
      const deleteIds = eligible.map((u) => u.id);
      if (deleteIds.length > 0) await tx.user.deleteMany({ where: { id: { in: deleteIds }, role: Role.SHOP_OWNER } });
      const owners = { deleted: deleteIds.length, detached: candidateIds.length - deleteIds.length };
      counts.users = deleteIds.length;

      const storageObjects = { documents: keys.documents.length, images: keys.images.length };
      await audit(tx, {
        shopId: null,
        actorUserId: opts.actor.type === 'PLATFORM_ADMIN' ? opts.actor.userId : null,
        actorType: opts.actor.type,
        action: 'admin.shop.delete',
        targetType: 'shop',
        targetId: shopId,
        metadata: {
          slug: shop.slug,
          displayName: shop.displayName,
          via: opts.via,
          ...(opts.actor.type === 'SYSTEM' ? { operator: opts.actor.marker } : {}),
          forced: Boolean(opts.force),
          counts,
          storageObjects,
          owners
        }
      });
      const result: ShopDeletionResult = { shopId, slug: shop.slug, displayName: shop.displayName, counts, storageObjects, owners, orphanedObjects: 0 };
      return { leftovers, result };
    },
    { timeout: 300_000, maxWait: 30_000 }
  );

  // Objects uploaded by a request that raced the first pass (the transaction held the shop lock, so none can appear later).
  for (const key of leftovers) {
    try {
      await ctx.storage.delete(key);
    } catch {
      result.orphanedObjects += 1;
      opts.log?.warn?.({ shopId }, 'shop delete: a late object could not be removed');
    }
  }
  ctx.events?.closeShop(shopId);
  ctx.notifications?.closeShop(shopId);
  return result;
}
