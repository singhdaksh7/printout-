import type { FastifyInstance } from 'fastify';
import { buildRevenueCsv, resolveRevenueRange, revenueQuery, revenueReport } from '../domain/revenue.js';
import { getLimiters } from '../rate-limits.js';
import { audit, authOf, json, shopGuard, shopIdOf, type AppContext } from './context.js';

/** Revenue & earnings (estimated order value only; see domain/revenue.ts). Shop-owner session required; tenant comes from the session. */
export async function shopRevenueRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  app.addHook('preHandler', shopGuard(ctx));

  app.get('/shop/analytics/revenue', { preHandler: limits.shopRead }, async (request, reply) => {
    const shopId = shopIdOf(request);
    const q = revenueQuery.parse(request.query);
    reply.header('cache-control', 'no-store');
    return json(await revenueReport(prisma, shopId, resolveRevenueRange(q)));
  });

  app.get('/shop/analytics/revenue/export.csv', { preHandler: limits.shopExport }, async (request, reply) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const q = revenueQuery.parse(request.query);
    const range = resolveRevenueRange(q);
    const { csv, rows, truncated } = await buildRevenueCsv(prisma, shopId, range);
    await audit(prisma, {
      shopId,
      actorUserId: auth.userId,
      action: 'revenue.export',
      targetType: 'shop',
      targetId: shopId,
      metadata: { from: range.fromYmd, to: range.toYmd, rows, truncated }
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="estimated-order-value-${range.fromYmd}_to_${range.toYmd}.csv"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-export-truncated', truncated ? 'true' : 'false')
      .send(csv);
  });
}
