import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { retentionCutoff, toNotificationDto } from '../notifications/shop-notifications.js';
import { getLimiters } from '../rate-limits.js';
import { idParam, json, shopGuard, shopIdOf, type AppContext } from './context.js';

const seqString = z.string().regex(/^\d{1,18}$/);
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /** Older than this seq (paging back). */
    cursor: seqString.optional(),
    /** Newer than this seq (catch-up after a reconnect). */
    after: seqString.optional(),
    unreadOnly: z.enum(['true', 'false', '1', '0']).optional()
  })
  .strict();

/**
 * Shop notification inbox. Every query is scoped by the session's shopId; ids from other shops are indistinguishable from
 * unknown ids (404). Read state is per shop (all staff of a shop share the inbox). No document data is ever returned.
 *
 *  GET  /shop/notifications            newest first; `cursor` pages back, `after` catches up; returns unreadCount
 *  POST /shop/notifications/:id/read   idempotent
 *  POST /shop/notifications/read-all   idempotent
 */
export async function shopNotificationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  app.addHook('preHandler', shopGuard(ctx));

  const visible = (shopId: string) => ({ shopId, createdAt: { gte: retentionCutoff(config.NOTIFICATION_RETENTION_DAYS) } });
  const unreadCount = (shopId: string) => prisma.shopNotification.count({ where: { ...visible(shopId), readAt: null } });

  app.get('/shop/notifications', { preHandler: limits.shopRead }, async (request) => {
    const shopId = shopIdOf(request);
    const q = listQuery.parse(request.query);
    const seq: { lt?: bigint; gt?: bigint } = {};
    if (q.cursor) seq.lt = BigInt(q.cursor);
    if (q.after) seq.gt = BigInt(q.after);
    const unreadOnly = q.unreadOnly === 'true' || q.unreadOnly === '1';
    const rows = await prisma.shopNotification.findMany({
      where: {
        ...visible(shopId),
        ...(seq.lt !== undefined || seq.gt !== undefined ? { seq } : {}),
        ...(unreadOnly ? { readAt: null } : {})
      },
      orderBy: { seq: 'desc' },
      take: q.limit + 1
    });
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const latest = await prisma.shopNotification.aggregate({ where: visible(shopId), _max: { seq: true } });
    return json({
      items: page.map(toNotificationDto),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.seq.toString() : null,
      hasMore,
      latestCursor: latest._max.seq?.toString() ?? null,
      unreadCount: await unreadCount(shopId)
    });
  });

  app.post('/shop/notifications/read-all', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    const res = await prisma.shopNotification.updateMany({ where: { shopId, readAt: null }, data: { readAt: new Date() } });
    return json({ updated: res.count, unreadCount: await unreadCount(shopId) });
  });

  app.post('/shop/notifications/:id/read', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    const { id } = idParam.parse(request.params);
    await prisma.shopNotification.updateMany({ where: { id, shopId, readAt: null }, data: { readAt: new Date() } });
    const row = await prisma.shopNotification.findFirst({ where: { id, shopId } });
    if (!row) throw notFound('Notification not found');
    return json({ notification: toNotificationDto(row), unreadCount: await unreadCount(shopId) });
  });
}
