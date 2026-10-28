import { OrderStatus, PaymentMethod, PaymentStatus, type Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../errors.js';
import { audit, isUniqueViolation } from '../routes/context.js';

/** UPI transaction references (UTR / RRN) are 12 digits; some apps show longer alphanumeric ids. Normalised to upper case. */
export const UPI_REF = /^[A-Za-z0-9]{8,22}$/;
export const normaliseUpiRef = (v: string) => v.trim().toUpperCase();

const DEAD_ORDER: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.REJECTED];

const invalid = (message: string, details?: unknown) => new AppError(409, 'INVALID_PAYMENT_TRANSITION', message, details);

type Actor = { userId: string; role: 'CUSTOMER' | 'SHOP_OWNER' | 'PLATFORM_ADMIN' };

async function lockedOrder(tx: Prisma.TransactionClient, where: Prisma.OrderWhereInput) {
  const found = await tx.order.findFirst({ where, select: { id: true } });
  if (!found) return null;
  // Row lock: concurrent payment actions on one order are serialised; the loser re-reads the new state.
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${found.id} FOR UPDATE`;
  return tx.order.findUniqueOrThrow({ where: { id: found.id } });
}

/**
 * Customer submits a UPI reference. This is a CLAIM: the order moves UNPAID -> PENDING_VERIFICATION and nothing is paid until the shop
 * verifies it. The same reference cannot be used on two orders of one shop (DUPLICATE_UTR).
 */
export async function submitUpiReference(prisma: PrismaClient, input: { customerUserId: string; orderId: string; upiTxnRef: string }) {
  const ref = normaliseUpiRef(input.upiTxnRef);
  try {
    return await prisma.$transaction(async (tx) => {
      const order = await lockedOrder(tx, { id: input.orderId, customerUserId: input.customerUserId });
      if (!order) return null;
      if (order.paymentMethod !== PaymentMethod.UPI) throw new AppError(409, 'NOT_UPI_ORDER', 'This order is not a UPI order');
      if (DEAD_ORDER.includes(order.status)) throw invalid('This order is closed');
      if (order.paymentStatus !== PaymentStatus.UNPAID) throw invalid('A payment reference was already submitted for this order', { paymentStatus: order.paymentStatus });
      const updated = await tx.order.update({ where: { id: order.id }, data: { paymentStatus: PaymentStatus.PENDING_VERIFICATION, upiTxnRef: ref } });
      await tx.orderPaymentEvent.create({
        data: { orderId: order.id, shopId: order.shopId, event: 'UPI_SUBMITTED', fromStatus: PaymentStatus.UNPAID, toStatus: PaymentStatus.PENDING_VERIFICATION, upiTxnRef: ref, actorUserId: input.customerUserId, actorRole: 'CUSTOMER' }
      });
      await audit(tx, { shopId: order.shopId, actorUserId: input.customerUserId, actorType: 'CUSTOMER', action: 'order.payment.upi_submitted', targetType: 'order', targetId: order.id });
      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'upiTxnRef')) throw new AppError(409, 'DUPLICATE_UTR', 'This payment reference was already used');
    throw error;
  }
}

/**
 * Shop owner decision. Only a human action marks money received: cash received (UNPAID -> PAID), UPI verified (PENDING_VERIFICATION -> PAID)
 * or a UPI reference rejected (PENDING_VERIFICATION -> UNPAID, reference cleared so the customer can resubmit).
 */
export async function setPaymentByShop(prisma: PrismaClient, input: { shopId: string; orderId: string; actor: Actor; to: 'PAID' | 'UNPAID' }) {
  return prisma.$transaction(async (tx) => {
    const order = await lockedOrder(tx, { id: input.orderId, shopId: input.shopId });
    if (!order) return null;
    if (!order.paymentMethod) throw invalid('This order has no payment method (it was placed without one)');
    if (DEAD_ORDER.includes(order.status)) throw invalid('This order is closed');
    const from = order.paymentStatus;
    let event: string;
    let data: Prisma.OrderUpdateInput;
    if (input.to === 'PAID') {
      if (order.paymentMethod === PaymentMethod.CASH && from === PaymentStatus.UNPAID) {
        event = 'CASH_RECEIVED';
        data = { paymentStatus: PaymentStatus.PAID };
      } else if (order.paymentMethod === PaymentMethod.UPI && from === PaymentStatus.PENDING_VERIFICATION) {
        event = 'UPI_VERIFIED';
        data = { paymentStatus: PaymentStatus.PAID };
      } else throw invalid(order.paymentMethod === PaymentMethod.UPI ? 'A UPI payment can be marked paid only after the customer submitted a reference' : 'This order cannot be marked paid', { paymentStatus: from });
    } else {
      if (order.paymentMethod !== PaymentMethod.UPI || from !== PaymentStatus.PENDING_VERIFICATION) throw invalid('Only a submitted UPI reference can be rejected', { paymentStatus: from });
      event = 'UPI_REJECTED';
      data = { paymentStatus: PaymentStatus.UNPAID, upiTxnRef: null };
    }
    const updated = await tx.order.update({ where: { id: order.id }, data });
    await tx.orderPaymentEvent.create({
      data: { orderId: order.id, shopId: order.shopId, event, fromStatus: from, toStatus: updated.paymentStatus, upiTxnRef: order.upiTxnRef, actorUserId: input.actor.userId, actorRole: 'SHOP_OWNER' }
    });
    await audit(tx, { shopId: order.shopId, actorUserId: input.actor.userId, actorType: 'SHOP_OWNER', action: `order.payment.${event.toLowerCase()}`, targetType: 'order', targetId: order.id, metadata: { from, to: updated.paymentStatus } });
    return updated;
  });
}

/**
 * Manual refund RECORD by a platform admin: PAID -> REFUNDED with a mandatory reason and an amount (default: the full order total).
 * No money moves here; the record documents what was returned outside the platform. Append-only event + audit.
 */
export async function recordRefundByAdmin(prisma: PrismaClient, input: { orderId: string; adminUserId: string; reason: string; amountPaise?: number | undefined }) {
  return prisma.$transaction(async (tx) => {
    const order = await lockedOrder(tx, { id: input.orderId });
    if (!order) return null;
    if (order.paymentStatus !== PaymentStatus.PAID) throw invalid('Only a paid order can be refunded', { paymentStatus: order.paymentStatus });
    const amount = input.amountPaise ?? order.totalPaise;
    if (amount < 1 || amount > order.totalPaise) throw new AppError(400, 'VALIDATION_ERROR', 'Refund amount must be between 1 paise and the order total', { field: 'amountPaise' });
    const updated = await tx.order.update({ where: { id: order.id }, data: { paymentStatus: PaymentStatus.REFUNDED } });
    await tx.orderPaymentEvent.create({
      data: { orderId: order.id, shopId: order.shopId, event: 'REFUND_RECORDED', fromStatus: PaymentStatus.PAID, toStatus: PaymentStatus.REFUNDED, upiTxnRef: order.upiTxnRef, amountPaise: amount, reason: input.reason, actorUserId: input.adminUserId, actorRole: 'PLATFORM_ADMIN' }
    });
    await audit(tx, { shopId: order.shopId, actorUserId: input.adminUserId, actorType: 'PLATFORM_ADMIN', action: 'order.payment.refund_recorded', targetType: 'order', targetId: order.id, metadata: { amountPaise: amount } });
    return updated;
  });
}

export const paymentLocksStatusChange = (status: PaymentStatus) => status === PaymentStatus.PAID || status === PaymentStatus.PENDING_VERIFICATION;

/** API spellings (PDF): cash|upi and unpaid|pendingVerification|paid|refunded. */
export const apiPaymentMethod = (m: PaymentMethod | null) => (m === null ? null : m === PaymentMethod.CASH ? 'cash' : 'upi');
export const apiPaymentStatus = (s: PaymentStatus) =>
  s === PaymentStatus.PENDING_VERIFICATION ? 'pendingVerification' : s === PaymentStatus.PAID ? 'paid' : s === PaymentStatus.REFUNDED ? 'refunded' : 'unpaid';
export const dbPaymentMethod = (m: 'cash' | 'upi') => (m === 'cash' ? PaymentMethod.CASH : PaymentMethod.UPI);
export const UPI_ID = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,31}$/;
