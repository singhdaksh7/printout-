import { OrderStatus, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { endOfIstDay, startOfIstDay } from '../domain/time.js';
import { AppError, notFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { audit, authOf, idParam, isUniqueViolation, json, shopGuard, shopIdOf, type AppContext } from './context.js';

const settingsBody = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    address: z.string().trim().max(300).nullable(),
    publicContact: z.string().trim().max(100).nullable(),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    acceptsOrders: z.boolean()
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one setting is required' });

const ruleFields = {
  paperSize: z.literal('A4'),
  colourMode: z.enum(['bw', 'colour']),
  sides: z.enum(['single', 'duplex']),
  pricePerSheetPaise: z.number().int().min(1).max(1_000_000),
  active: z.boolean()
};
const createRuleBody = z.object({ ...ruleFields, paperSize: ruleFields.paperSize.default('A4'), active: ruleFields.active.default(true) }).strict();
const updateRuleBody = z
  .object(ruleFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

const analyticsQuery = z
  .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
  .strict();

const ruleView = (r: {
  id: string;
  paperSize: string;
  colourMode: string;
  sides: string;
  pricePerSheetPaise: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: r.id,
  paperSize: r.paperSize,
  colourMode: r.colourMode,
  sides: r.sides,
  pricePerSheetPaise: r.pricePerSheetPaise,
  active: r.active,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
});

const duplicateRule = () =>
  new AppError(409, 'DUPLICATE_PRICING_RULE', 'A pricing rule for this colour mode and sides already exists');

export async function shopConfigRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  app.addHook('preHandler', shopGuard(ctx));

  async function settingsView(shopId: string) {
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, include: { settings: true } });
    return {
      slug: shop.slug,
      displayName: shop.displayName,
      address: shop.address,
      publicContact: shop.settings?.publicContact ?? null,
      brandColor: shop.settings?.brandColor ?? null,
      acceptsOrders: shop.acceptsOrders
    };
  }

  app.get('/shop/settings', { preHandler: limits.shopRead }, async (request) => json(await settingsView(shopIdOf(request))));

  app.put('/shop/settings', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const body = settingsBody.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const shopData: Prisma.ShopUpdateInput = {};
      if (body.displayName !== undefined) shopData.displayName = body.displayName;
      if (body.address !== undefined) shopData.address = body.address;
      if (body.acceptsOrders !== undefined) shopData.acceptsOrders = body.acceptsOrders;
      if (Object.keys(shopData).length > 0) await tx.shop.update({ where: { id: shopId }, data: shopData });
      const settingsData: { publicContact?: string | null; brandColor?: string | null } = {};
      if (body.publicContact !== undefined) settingsData.publicContact = body.publicContact;
      if (body.brandColor !== undefined) settingsData.brandColor = body.brandColor;
      await tx.shopSettings.upsert({ where: { shopId }, create: { shopId, ...settingsData }, update: settingsData });
      await audit(tx, {
        shopId,
        actorUserId: auth.userId,
        action: 'shop.settings.update',
        targetType: 'shop',
        targetId: shopId,
        metadata: { fields: Object.keys(body) }
      });
    });
    return json(await settingsView(shopId));
  });

  app.get('/shop/pricing-rules', { preHandler: limits.shopRead }, async (request) => {
    const rules = await prisma.pricingRule.findMany({
      where: { shopId: shopIdOf(request) },
      orderBy: [{ colourMode: 'asc' }, { sides: 'asc' }]
    });
    return json(rules.map(ruleView));
  });

  app.post('/shop/pricing-rules', { preHandler: limits.shopMutation }, async (request, reply) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const body = createRuleBody.parse(request.body);
    try {
      const rule = await prisma.$transaction(async (tx) => {
        const created = await tx.pricingRule.create({ data: { shopId, ...body } });
        await audit(tx, {
          shopId,
          actorUserId: auth.userId,
          action: 'pricing.create',
          targetType: 'pricingRule',
          targetId: created.id,
          metadata: { colourMode: body.colourMode, sides: body.sides, pricePerSheetPaise: body.pricePerSheetPaise, active: body.active }
        });
        return created;
      });
      reply.code(201);
      return json(ruleView(rule));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateRule();
      throw error;
    }
  });

  app.put('/shop/pricing-rules/:id', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    const body = updateRuleBody.parse(request.body);
    try {
      const rule = await prisma.$transaction(async (tx) => {
        const updated = await tx.pricingRule.updateMany({ where: { id, shopId }, data: body });
        if (updated.count !== 1) throw notFound('Pricing rule not found');
        await audit(tx, {
          shopId,
          actorUserId: auth.userId,
          action: 'pricing.update',
          targetType: 'pricingRule',
          targetId: id,
          metadata: body
        });
        return tx.pricingRule.findFirstOrThrow({ where: { id, shopId } });
      });
      return json(ruleView(rule));
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateRule();
      throw error;
    }
  });

  app.delete('/shop/pricing-rules/:id', { preHandler: limits.shopMutation }, async (request, reply) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    await prisma.$transaction(async (tx) => {
      const deleted = await tx.pricingRule.deleteMany({ where: { id, shopId } });
      if (deleted.count !== 1) throw notFound('Pricing rule not found');
      await audit(tx, { shopId, actorUserId: auth.userId, action: 'pricing.delete', targetType: 'pricingRule', targetId: id });
    });
    return reply.code(204).send();
  });

  app.get('/shop/qr', { preHandler: limits.shopRead }, async (request) => {
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopIdOf(request) } });
    return json({
      publicUrl: `${config.WEB_ORIGIN.replace(/\/$/, '')}/p/${shop.slug}`,
      slug: shop.slug,
      shopName: shop.displayName
    });
  });

  app.get('/shop/analytics', { preHandler: limits.shopRead }, async (request) => {
    const shopId = shopIdOf(request);
    const q = analyticsQuery.parse(request.query);
    const from = q.from ?? startOfIstDay();
    const to = q.to ?? endOfIstDay();
    if (to <= from) throw new AppError(400, 'VALIDATION_ERROR', '`to` must be after `from`');
    if (to.getTime() - from.getTime() > 93 * 86_400_000) throw new AppError(400, 'VALIDATION_ERROR', 'Range too large (max 93 days)');

    const [orders, recent] = await Promise.all([
      prisma.order.findMany({
        where: { shopId, createdAt: { gte: from, lt: to } },
        select: { status: true, totalPaise: true, printOptionsSnapshot: true, priceSnapshot: true }
      }),
      prisma.orderStatusHistory.findMany({
        where: { order: { shopId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: { fromStatus: true, toStatus: true, createdAt: true, order: { select: { id: true, orderNumber: true } } }
      })
    ]);

    const ordersByStatus = Object.fromEntries(Object.values(OrderStatus).map((s) => [s, 0])) as Record<OrderStatus, number>;
    let pages = 0;
    let value = 0;
    let bw = 0;
    let colour = 0;
    for (const o of orders) {
      ordersByStatus[o.status] += 1;
      if (o.status === OrderStatus.CANCELLED || o.status === OrderStatus.EXPIRED) continue;
      const options = o.printOptionsSnapshot as { copies?: number; colourMode?: string };
      const selected = (o.priceSnapshot as { selectedPageCount?: number }).selectedPageCount ?? 0;
      pages += selected * (options.copies ?? 1);
      value += o.totalPaise;
      if (options.colourMode === 'colour') colour += 1;
      else bw += 1;
    }
    return json({
      timezone: 'Asia/Kolkata',
      range: { from, to },
      ordersToday: orders.length,
      orderCount: orders.length,
      // pagesToday = sum(selectedPageCount x copies) over non-cancelled/expired orders in range.
      pagesToday: pages,
      // Sum of order totals (cash is settled outside the app) - an estimate, deliberately not "revenue".
      estimatedOrderValuePaise: value,
      bwCount: bw,
      colourCount: colour,
      ordersByStatus,
      recentActivity: recent.map((h) => ({
        orderId: h.order.id,
        orderNumber: h.order.orderNumber,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        at: h.createdAt
      }))
    });
  });
}
