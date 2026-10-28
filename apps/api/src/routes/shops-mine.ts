import type { FastifyInstance } from 'fastify';
import { listOwnedShops } from '../domain/shop-access.js';
import { getLimiters } from '../rate-limits.js';
import { authOf, authenticate, json, type AppContext } from './context.js';
import { AppError } from '../errors.js';

/**
 * GET /shops/mine: every shop the signed-in owner may act on (default shop + OWNER memberships). Additive: the single-shop
 * GET /shops/me and every /shop/* route are unchanged and keep resolving the default shop.
 * Owner-only; the list is computed from the session user, never from a request parameter.
 */
export async function shopsMineRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/shops/mine', { preHandler: [async (request) => {
    const auth = await authenticate(ctx, request, { allowSuspended: true });
    if (auth.role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'Shop account required');
  }, limits.shopRead] }, async (request) => {
    const shops = await listOwnedShops(prisma, authOf(request).userId);
    const items = shops.map((s) => ({
      id: s.id,
      slug: s.slug,
      shopName: s.displayName,
      shopStatus: s.status,
      isActive: s.status === 'ACTIVE',
      acceptsOrders: s.acceptsOrders,
      isDefault: s.isDefault,
      createdAt: s.createdAt.toISOString()
    }));
    return json({ items, page: 1, limit: items.length, total: items.length, defaultShopId: shops.find((s) => s.isDefault)?.id ?? null });
  });
}
