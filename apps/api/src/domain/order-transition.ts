import { OrderStatus, type Order } from '@prisma/client';
import { AppError, orderNotFound } from '../errors.js';
import { audit, type AppContext } from '../routes/context.js';
import { assertRequestedTransition } from './lifecycle.js';
import { paymentLocksStatusChange } from './payments.js';
import { pushCustomerNotification, recordCustomerNotification } from './customer-notifications.js';

/**
 * The ONE shop-side status change (used by POST /shop/orders/:id/transitions and PATCH /shops/{shopId}/orders/{orderId}/status).
 * Compare-and-set inside one transaction, append-only history, audit; events are emitted by the caller after commit.
 * REJECTED (decision D7) is available only while ORDER_REJECT_ENABLED, needs a reason, and is refused while money is recorded or claimed.
 */
export async function shopChangeStatus(
  ctx: AppContext,
  input: { shopId: string; orderId: string; actorUserId: string; toStatus: OrderStatus; reason?: string | undefined }
): Promise<{ order: Order; changed: boolean }> {
  const { prisma, config } = ctx;
  if (input.toStatus === OrderStatus.REJECTED) {
    if (!config.ORDER_REJECT_ENABLED) throw new AppError(409, 'FEATURE_DISABLED', 'Rejecting orders is not enabled yet');
    if (!input.reason?.trim()) throw new AppError(400, 'VALIDATION_ERROR', 'A reason is required to reject an order', { field: 'reason' });
  }
  const outcome = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: input.orderId, shopId: input.shopId }, include: { document: true } });
    if (!order) throw orderNotFound();
    if (order.status === input.toStatus) return { order, changed: false, notification: null };
    const from = order.status;
    assertRequestedTransition(from, input.toStatus);
    if (input.toStatus === OrderStatus.REJECTED && paymentLocksStatusChange(order.paymentStatus)) {
      throw new AppError(409, 'PAYMENT_RECORDED', 'Resolve the recorded payment first (mark the reference unpaid, or ask an admin to record a refund)');
    }
    const updated = await tx.order.updateMany({ where: { id: input.orderId, shopId: input.shopId, status: from }, data: { status: input.toStatus } });
    if (updated.count !== 1) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Order status changed concurrently; reload and retry');
    await tx.orderStatusHistory.create({ data: { orderId: input.orderId, fromStatus: from, toStatus: input.toStatus, reason: input.reason ?? null, actorUserId: input.actorUserId } });
    await audit(tx, { shopId: input.shopId, actorUserId: input.actorUserId, action: 'order.transition', targetType: 'order', targetId: input.orderId, metadata: { from, to: input.toStatus } });
    const fresh = await tx.order.findFirstOrThrow({ where: { id: input.orderId, shopId: input.shopId } });
    const notification = await recordCustomerNotification(tx, { customerUserId: fresh.customerUserId, event: input.toStatus === OrderStatus.REJECTED ? 'order.rejected' : 'order.cancelled', orderId: fresh.id, orderNumber: fresh.orderNumber });
    return { order: fresh, changed: true, notification };
  });
  pushCustomerNotification(ctx, outcome.notification);
  return { order: outcome.order, changed: outcome.changed };
}
