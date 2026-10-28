import { DocumentStatus, OrderStatus, type Order, type PaymentMethod, type Prisma, type ShopSettings } from '@prisma/client';
import { newToken } from '../auth.js';
import { AppError } from '../errors.js';
import { notifyShopOwners } from '../notifications/fcm.js';
import { recordOrderCreated, toNotificationDto } from '../notifications/shop-notifications.js';
import { isUniqueViolation, type AppContext } from '../routes/context.js';
import { assertAcceptingByHours } from './hours-view.js';
import { normalisePrintOptions, quote, type PrintOptions, type QuoteResult } from './pricing.js';

export function orderNumberPrefix(slug: string): string {
  const letters = slug.replace(/[^a-z0-9]/g, '').toUpperCase().slice(0, 6);
  return letters.length >= 2 ? letters : 'ORD';
}

export interface CreateOrderInput {
  shop: { id: string; slug: string; settings: ShopSettings | null };
  /** Already verified quote payload (signature and expiry checked by the caller). */
  payload: { documentId: string; shopId: string; printOptions: PrintOptions };
  clientRequestId: string;
  customerDisplayNameOrReference?: string | null;
  /** Set for authenticated marketplace customers; null/absent for guest QR orders. */
  customerUserId?: string | null;
  note?: string | null;
  /** Customer orders only; guest QR orders have none. */
  paymentMethod?: PaymentMethod | null;
}

/**
 * The ONE order-creation path, shared by the guest QR flow (POST /public/shops/:slug/orders, behaviour unchanged) and the customer flow
 * (POST /customer/orders). Server-authoritative price (the shop's CURRENT active rules, integer paise), idempotency per
 * (shop, clientRequestId), single-use documents, hours re-checked inside the row-locked transaction, transactional outbox, and every
 * notification only after commit.
 *
 * Ownership rules (schema-v2): a customer order may consume only documents that customer uploaded; a guest order may consume only
 * documents that no customer uploaded; an idempotent replay is returned only to the same principal.
 */
export async function createOrderFromQuote(ctx: AppContext, input: CreateOrderInput): Promise<Order> {
  const { prisma, events } = ctx;
  const { shop, payload, clientRequestId } = input;
  const customerUserId = input.customerUserId ?? null;
  const sameOwner = (order: { customerUserId: string | null }) => order.customerUserId === customerUserId;
  const replay = (order: Order, documentId: string): Order => {
    if (!sameOwner(order) || order.documentId !== documentId) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'clientRequestId was already used for a different order');
    }
    return order;
  };

  // Idempotent retry: same clientRequestId returns the original order.
  const existing = await prisma.order.findUnique({ where: { shopId_clientRequestId: { shopId: shop.id, clientRequestId } } });
  if (existing) return replay(existing, payload.documentId);

  // Fast pre-check (the authoritative one runs inside the transaction below). Idempotent replays above stay allowed.
  assertAcceptingByHours(shop.settings);

  const now = new Date();
  const doc = await prisma.document.findFirst({ where: { id: payload.documentId, shopId: shop.id }, include: { order: { select: { id: true } } } });
  if (!doc || doc.uploaderUserId !== customerUserId) throw new AppError(422, 'DOCUMENT_UNAVAILABLE', 'Document is no longer available');
  if (doc.order) {
    const original = await prisma.order.findUnique({ where: { shopId_clientRequestId: { shopId: shop.id, clientRequestId } } });
    if (original?.documentId === doc.id) return replay(original, doc.id);
    throw new AppError(409, 'DOCUMENT_ALREADY_USED', 'This document already has an order');
  }
  if (doc.status !== DocumentStatus.AVAILABLE || !doc.expiresAt || doc.expiresAt <= now || !doc.pageCount) {
    throw new AppError(422, 'DOCUMENT_UNAVAILABLE', 'Document is no longer available');
  }

  // Authoritative recalculation with the shop's CURRENT active rules; nothing price-like is trusted from the token.
  const rules = await prisma.pricingRule.findMany({ where: { shopId: shop.id, active: true } });
  const result: QuoteResult = quote(
    normalisePrintOptions(payload.printOptions, doc.pageCount),
    doc.pageCount,
    rules.map((r) => ({ ...r, paperSize: 'A4' as const }))
  );

  try {
    const { order, notification } = await prisma.$transaction(async (tx) => {
      const claimed = await tx.document.updateMany({
        where: { id: doc.id, shopId: shop.id, status: DocumentStatus.AVAILABLE, expiresAt: { gt: now }, order: { is: null } },
        data: { updatedAt: now }
      });
      if (claimed.count !== 1) throw new AppError(409, 'DOCUMENT_ALREADY_USED', 'This document already has an order');
      // Row-locking counter => collision-free, human-readable per-shop sequence (e.g. CENTRA-0001).
      const { orderCounter } = await tx.shop.update({ where: { id: shop.id }, data: { orderCounter: { increment: 1 } }, select: { orderCounter: true } });
      // The shop row is now locked, and settings mutations lock it too: evaluate hours at THIS instant against the committed settings.
      assertAcceptingByHours(await tx.shopSettings.findUnique({ where: { shopId: shop.id } }));
      const created = await tx.order.create({
        data: {
          shopId: shop.id,
          documentId: doc.id,
          orderNumber: `${orderNumberPrefix(shop.slug)}-${String(orderCounter).padStart(4, '0')}`,
          trackingToken: newToken(),
          clientRequestId,
          customerDisplayNameOrReference: input.customerDisplayNameOrReference || null,
          customerUserId,
          note: input.note ?? null,
          paymentMethod: input.paymentMethod ?? null,
          totalPaise: result.totalPaise,
          priceSnapshot: result as unknown as Prisma.InputJsonValue,
          printOptionsSnapshot: result.printOptions as unknown as Prisma.InputJsonValue,
          histories: { create: { toStatus: OrderStatus.NEW, actorUserId: customerUserId } }
        }
      });
      // Transactional outbox: the notification commits (or rolls back) together with the order.
      const row = await recordOrderCreated(tx, { shopId: shop.id, orderId: created.id, orderNumber: created.orderNumber });
      return { order: created, notification: row };
    });
    try {
      // Post-commit fan-out is best effort: the durable row is the source of truth and clients recover via the cursor list.
      ctx.notifications.publish(shop.id, toNotificationDto(notification));
    } catch {
      /* ignored */
    }
    // Mobile push AFTER commit, to this shop's owners only; best effort, never awaited, no customer data in the payload.
    void notifyShopOwners(ctx, shop.id, { type: 'order.new', orderId: order.id, title: 'New print order' });
    events.emit(shop.id, 'order.created', { id: order.id, orderNumber: order.orderNumber, status: order.status, updatedAt: order.updatedAt });
    try {
      // Fire-and-forget device signal (order id only); must never affect the customer response.
      ctx.notifier.notifyNewPrintRequest(shop.id, order.id);
    } catch {
      /* ignored */
    }
    return order;
  } catch (error) {
    const raceLost =
      isUniqueViolation(error, 'clientRequestId') || isUniqueViolation(error, 'documentId') || (error instanceof AppError && error.code === 'DOCUMENT_ALREADY_USED');
    if (raceLost) {
      // A concurrent request with the same clientRequestId may have won: return its order (to the same principal only).
      const original = await prisma.order.findUnique({ where: { shopId_clientRequestId: { shopId: shop.id, clientRequestId } } });
      if (original) return replay(original, doc.id);
      throw new AppError(409, 'DOCUMENT_ALREADY_USED', 'This document already has an order');
    }
    throw error;
  }
}
