import { OrderStatus, type Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { shopChangeStatus } from '../domain/order-transition.js';
import { apiPaymentMethod, apiPaymentStatus, recordRefundByAdmin, setPaymentByShop } from '../domain/payments.js';
import { requireOwnedShop } from '../domain/shop-access.js';
import { AppError, orderNotFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { adminGuard, assertCsrf, authenticate, authOf, json, type AppContext } from './context.js';

const ids = z.object({ shopId: z.string().min(8).max(64), orderId: z.string().min(8).max(64) }).strict();
const shopOnly = z.object({ shopId: z.string().min(8).max(64) }).strict();
const paymentBody = z.object({ paymentStatus: z.enum(['paid', 'unpaid']) }).strict();
const statusBody = z.object({ status: z.enum(['accepted', 'printing', 'ready', 'completed', 'rejected', 'cancelled']), rejectReason: z.string().trim().max(250).optional() }).strict();
const listQuery = z
  .object({ status: z.nativeEnum(OrderStatus).optional(), page: z.coerce.number().int().min(1).max(1000).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();
const refundBody = z.object({ reason: z.string().trim().min(3).max(300), amountPaise: z.number().int().min(1).max(2_000_000_000).optional() }).strict();

/**
 * Shop-side payment and status controls for the multi-shop owner API, and the admin-only manual refund record.
 * Every /shops/{shopId}/... handler goes through requireOwnedShop (a foreign shop is a 404) and re-scopes the order to that shop.
 * Nothing here moves money or calls a gateway; a customer's UPI reference is never trusted, only a shop owner's explicit action
 * marks a payment received.
 */
export async function orderPaymentRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, events } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const ownerGuard = async (request: FastifyRequest) => {
    const auth = await authenticate(ctx, request);
    if (auth.role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'Shop account required');
    if (request.method !== 'GET') assertCsrf(ctx, request, auth);
  };

  app.get('/shops/:shopId/orders', { preHandler: [ownerGuard, limits.shopRead] }, async (request) => {
    const { shopId } = shopOnly.parse(request.params);
    await requireOwnedShop(prisma, authOf(request).userId, shopId);
    const q = listQuery.parse(request.query);
    const where: Prisma.OrderWhereInput = { shopId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, include: { document: true, customer: { select: { displayName: true } } } }),
      prisma.order.count({ where })
    ]);
    // The customer's login phone and email are never exposed to the shop; only a display name.
    return json({
      items: rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.customer?.displayName ?? o.customerDisplayNameOrReference ?? null,
        fileName: o.document.originalFilename,
        pages: o.document.pageCount,
        printOptions: o.printOptionsSnapshot,
        note: o.note,
        totalPaise: o.totalPaise,
        status: o.status,
        paymentMethod: apiPaymentMethod(o.paymentMethod),
        paymentStatus: apiPaymentStatus(o.paymentStatus),
        upiTxnRef: o.upiTxnRef,
        createdAt: o.createdAt
      })),
      page: q.page,
      limit: q.limit,
      total
    });
  });

  /**
   * Status adapter. Today the shop's only direct status actions are cancel and (when ORDER_REJECT_ENABLED) reject; accepting, printing,
   * ready and completed are produced by the Print action and the device flow, so they are refused instead of faked.
   */
  app.patch('/shops/:shopId/orders/:orderId/status', { preHandler: [ownerGuard, limits.status] }, async (request) => {
    const auth = authOf(request);
    const { shopId, orderId } = ids.parse(request.params);
    await requireOwnedShop(prisma, auth.userId, shopId);
    const body = statusBody.parse(request.body);
    if (body.status !== 'rejected' && body.status !== 'cancelled') {
      throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This status is set by the Print action, not directly', { status: body.status });
    }
    const result = await shopChangeStatus(ctx, { shopId, orderId, actorUserId: auth.userId, toStatus: body.status === 'rejected' ? OrderStatus.REJECTED : OrderStatus.CANCELLED, reason: body.rejectReason });
    if (result.changed) {
      const payload = { id: result.order.id, orderNumber: result.order.orderNumber, status: result.order.status, updatedAt: result.order.updatedAt };
      events.emit(shopId, 'order.statusChanged', payload);
      events.emit(shopId, 'order.updated', payload);
    }
    return json({ id: result.order.id, status: result.order.status, updatedAt: result.order.updatedAt });
  });

  app.patch('/shops/:shopId/orders/:orderId/payment', { preHandler: [ownerGuard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const { shopId, orderId } = ids.parse(request.params);
    await requireOwnedShop(prisma, auth.userId, shopId);
    const body = paymentBody.parse(request.body);
    const updated = await setPaymentByShop(prisma, { shopId, orderId, actor: { userId: auth.userId, role: 'SHOP_OWNER' }, to: body.paymentStatus === 'paid' ? 'PAID' : 'UNPAID' });
    if (!updated) throw orderNotFound();
    return json({ id: updated.id, paymentMethod: apiPaymentMethod(updated.paymentMethod), paymentStatus: apiPaymentStatus(updated.paymentStatus), upiTxnRef: updated.upiTxnRef });
  });

  /** Admin-only manual refund RECORD (PAID -> REFUNDED). Records what was returned outside the platform; no money moves. */
  app.post('/admin/orders/:id/refund', { preHandler: [adminGuard(ctx), limits.adminMutation] }, async (request) => {
    const auth = authOf(request);
    const { id } = z.object({ id: z.string().min(8).max(64) }).strict().parse(request.params);
    const body = refundBody.parse(request.body);
    const updated = await recordRefundByAdmin(prisma, { orderId: id, adminUserId: auth.userId, reason: body.reason, amountPaise: body.amountPaise });
    if (!updated) throw orderNotFound();
    return json({ id: updated.id, paymentStatus: apiPaymentStatus(updated.paymentStatus), totalPaise: updated.totalPaise });
  });
}
