import type { Prisma, PrismaClient, UserNotification } from '@prisma/client';
import { notifyUser } from '../notifications/fcm.js';
import type { AppContext } from '../routes/context.js';

/**
 * Customer notifications (schema-v2 phase 5): a durable in-app inbox row written INSIDE the transaction that changes the order or the
 * payment (transactional outbox: committed change <=> committed notification), then a best-effort push AFTER commit. A push failure never
 * rolls anything back. Guest QR orders (no customer) produce nothing. Texts are generic and carry only the order number: no file names,
 * amounts, references or contact data, on the inbox, in the push, or in the audit trail.
 */
export type CustomerEvent =
  | 'order.rejected'
  | 'order.cancelled'
  | 'order.printing'
  | 'order.expired'
  | 'payment.paid'
  | 'payment.rejected'
  | 'payment.refunded';

const TEXTS: Record<CustomerEvent, { type: 'orderStatus' | 'payment'; title: string; body: (n: string) => string }> = {
  'order.rejected': { type: 'orderStatus', title: 'Order rejected', body: (n) => `The shop could not take order ${n}.` },
  'order.cancelled': { type: 'orderStatus', title: 'Order cancelled', body: (n) => `Order ${n} was cancelled by the shop.` },
  'order.printing': { type: 'orderStatus', title: 'Printing started', body: (n) => `The shop started printing order ${n}.` },
  'order.expired': { type: 'orderStatus', title: 'Order expired', body: (n) => `Order ${n} expired because its file is no longer available.` },
  'payment.paid': { type: 'payment', title: 'Payment received', body: (n) => `The shop marked order ${n} as paid.` },
  'payment.rejected': { type: 'payment', title: 'Payment reference not accepted', body: (n) => `The shop could not verify the payment reference for order ${n}. You can submit it again.` },
  'payment.refunded': { type: 'payment', title: 'Refund recorded', body: (n) => `A refund was recorded for order ${n}.` }
};

type Db = PrismaClient | Prisma.TransactionClient;

/** Idempotent per (user, event, order, occurrence key): a replay of the same event is a no-op. Returns null for guest orders. */
export async function recordCustomerNotification(
  db: Db,
  input: { customerUserId: string | null; event: CustomerEvent; orderId: string; orderNumber: string; occurrence?: string }
): Promise<UserNotification | null> {
  if (!input.customerUserId) return null;
  const t = TEXTS[input.event];
  const dedupeKey = `${input.event}:${input.orderId}${input.occurrence ? `:${input.occurrence}` : ''}`;
  return db.userNotification.upsert({
    where: { userId_dedupeKey: { userId: input.customerUserId, dedupeKey } },
    create: { userId: input.customerUserId, type: t.type, title: t.title, body: t.body(input.orderNumber), orderId: input.orderId, dedupeKey },
    update: {}
  });
}

/** Post-commit push to the customer's own registered devices. Never throws. */
export function pushCustomerNotification(ctx: AppContext, row: UserNotification | null): void {
  if (!row) return;
  void notifyUser(ctx, row.userId, { type: row.type === 'payment' ? 'payment.updated' : 'order.updated', orderId: row.orderId ?? '', title: row.title });
}

export const notificationView = (n: Pick<UserNotification, 'id' | 'type' | 'title' | 'body' | 'orderId' | 'readAt' | 'createdAt'>) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  orderId: n.orderId,
  readAt: n.readAt,
  createdAt: n.createdAt
});
