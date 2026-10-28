import { OrderStatus, type Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notificationView } from '../domain/customer-notifications.js';
import { requireOwnedShop } from '../domain/shop-access.js';
import { AppError, notFound, orderNotFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { assertCsrf, audit, authenticate, authOf, customerGuard, isUniqueViolation, json, type AppContext } from './context.js';

/** An order may be reviewed once the shop's Print action has started (the shop's completion signal in this system) or any later status. */
export const REVIEWABLE_STATUSES: OrderStatus[] = [OrderStatus.PRINTING, OrderStatus.PRINTED, OrderStatus.READY, OrderStatus.COLLECTED];
export const MAX_REVIEWS_PER_DAY = 30;
export const MAX_COMMENT_LENGTH = 1000;

/** Plain text only: control characters are refused, outer whitespace trimmed, empty means no comment. Clients must escape on display. */
const comment = z
  .string()
  .max(MAX_COMMENT_LENGTH * 2)
  .transform((v) => v.trim())
  .refine((v) => v.length <= MAX_COMMENT_LENGTH, { message: `Comment must be at most ${MAX_COMMENT_LENGTH} characters` })
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), { message: 'Comment contains invalid characters' })
  .transform((v) => (v.length === 0 ? null : v));

const reviewBody = z.object({ orderId: z.string().min(8).max(64), rating: z.number().int().min(1).max(5), comment: comment.optional() }).strict();
const shopParam = z.object({ shopId: z.string().min(8).max(64) }).strict();
const pageQuery = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
const inboxQuery = pageQuery.extend({ unread: z.enum(['true', 'false']).optional() }).strict();
const idParam = z.object({ id: z.string().min(8).max(64) }).strict();

/** "Rahul Kumar" -> "Rahul K." : reviews never show a full customer name. */
export function publicName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Customer';
  const first = parts[0]!.slice(0, 30);
  return parts.length > 1 ? `${first} ${[...parts.at(-1)!][0]!.toUpperCase()}.` : first;
}

const reviewView = (r: { id: string; rating: number; comment: string | null; createdAt: Date; customer: { displayName: string } }) => ({
  id: r.id,
  rating: r.rating,
  comment: r.comment,
  customerName: publicName(r.customer.displayName),
  createdAt: r.createdAt
});

/** Customer reviews, rating aggregates, and the customer notification inbox (schema-v2 phase 5; NEW routes). */
export async function customerReviewRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  const guard = customerGuard(ctx);
  const ownerGuard = async (request: FastifyRequest) => {
    const auth = await authenticate(ctx, request);
    if (auth.role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'Shop account required');
    if (request.method !== 'GET') assertCsrf(ctx, request, auth);
  };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post('/customer/reviews', { preHandler: [guard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const body = reviewBody.parse(request.body);
    const since = new Date(Date.now() - 86_400_000);
    if ((await prisma.review.count({ where: { customerUserId: auth.userId, createdAt: { gt: since } } })) >= MAX_REVIEWS_PER_DAY) throw new AppError(429, 'RATE_LIMITED', 'Too many reviews. Try again later.');
    try {
      const review = await prisma.$transaction(async (tx) => {
        const mine = await tx.order.findFirst({ where: { id: body.orderId, customerUserId: auth.userId }, select: { id: true } });
        if (!mine) throw orderNotFound(); // another customer's order is indistinguishable from a missing one
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${mine.id} FOR UPDATE`;
        const order = await tx.order.findUniqueOrThrow({ where: { id: mine.id } });
        if (order.isReviewed) throw new AppError(409, 'REVIEW_EXISTS', 'This order was already reviewed');
        if (!REVIEWABLE_STATUSES.includes(order.status)) throw new AppError(422, 'ORDER_NOT_COMPLETED', 'You can review an order once printing has started', { status: order.status });
        const created = await tx.review.create({ data: { orderId: order.id, customerUserId: auth.userId, shopId: order.shopId, rating: body.rating, comment: body.comment ?? null } });
        await tx.order.update({ where: { id: order.id }, data: { isReviewed: true } });
        // Atomic aggregate: SET expressions read the old row, so the new average uses the new sum and count.
        await tx.$executeRaw`UPDATE "Shop" SET "ratingSum" = "ratingSum" + ${body.rating}, "ratingCount" = "ratingCount" + 1,
          "ratingAvg" = round(("ratingSum" + ${body.rating})::numeric / ("ratingCount" + 1), 1) WHERE id = ${order.shopId}`;
        await audit(tx, { shopId: order.shopId, actorUserId: auth.userId, actorType: 'CUSTOMER', action: 'review.created', targetType: 'order', targetId: order.id, metadata: { rating: body.rating } });
        return created;
      });
      reply.code(201);
      return json({ id: review.id, orderId: review.orderId, shopId: review.shopId, rating: review.rating, comment: review.comment, createdAt: review.createdAt });
    } catch (error) {
      if (isUniqueViolation(error, 'orderId')) throw new AppError(409, 'REVIEW_EXISTS', 'This order was already reviewed');
      throw error;
    }
  });

  async function listReviews(shopId: string, q: z.infer<typeof pageQuery>) {
    const where: Prisma.ReviewWhereInput = { shopId };
    const [rows, total, shop] = await Promise.all([
      prisma.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, include: { customer: { select: { displayName: true } } } }),
      prisma.review.count({ where }),
      prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { ratingAvg: true, ratingCount: true } })
    ]);
    return { items: rows.map(reviewView), page: q.page, limit: q.limit, total, ratingAvg: shop.ratingCount > 0 ? shop.ratingAvg : null, ratingCount: shop.ratingCount };
  }

  app.get('/customer/shops/:shopId/reviews', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const { shopId } = shopParam.parse(request.params);
    const shop = await prisma.shop.findFirst({ where: { id: shopId, isVerified: true, status: 'ACTIVE' }, select: { id: true } });
    if (!shop) throw notFound('Shop not found');
    return json(await listReviews(shop.id, pageQuery.parse(request.query)));
  });

  app.get('/shops/:shopId/reviews', { preHandler: [ownerGuard, limits.shopRead] }, async (request) => {
    const { shopId } = shopParam.parse(request.params);
    await requireOwnedShop(prisma, authOf(request).userId, shopId);
    return json(await listReviews(shopId, pageQuery.parse(request.query)));
  });

  // ---- customer notification inbox ---------------------------------------------------------------------------------------------

  app.get('/customer/notifications', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const auth = authOf(request);
    const q = inboxQuery.parse(request.query);
    const where: Prisma.UserNotificationWhereInput = { userId: auth.userId, ...(q.unread === 'true' ? { readAt: null } : {}) };
    const [rows, total, unreadCount] = await Promise.all([
      prisma.userNotification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      prisma.userNotification.count({ where }),
      prisma.userNotification.count({ where: { userId: auth.userId, readAt: null } })
    ]);
    return json({ items: rows.map(notificationView), page: q.page, limit: q.limit, total, unreadCount });
  });

  app.post('/customer/notifications/:id/read', { preHandler: [guard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    // Own rows only; someone else's id answers like a missing one. Idempotent: an already-read row keeps its first readAt.
    const row = await prisma.userNotification.findFirst({ where: { id, userId: auth.userId }, select: { id: true } });
    if (!row) throw notFound('Notification not found');
    await prisma.userNotification.updateMany({ where: { id, userId: auth.userId, readAt: null }, data: { readAt: new Date() } });
    return reply.code(204).send();
  });

  app.post('/customer/notifications/read-all', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const res = await prisma.userNotification.updateMany({ where: { userId: authOf(request).userId, readAt: null }, data: { readAt: new Date() } });
    return json({ updated: res.count });
  });
}
