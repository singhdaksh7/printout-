import { OrderStatus, Role, ShopStatus, SubscriptionStatus, type Document, type Order, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth.js';
import { startOfIstDay, endOfIstDay } from '../domain/time.js';
import { AppError, notFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import {
  adminGuard,
  audit,
  authOf,
  cursorWhere,
  decodeCursor,
  encodeCursor,
  idParam,
  isUniqueViolation,
  json,
  type AppContext
} from './context.js';

const RESERVED_SLUGS = new Set(['admin', 'api', 'www', 'shop', 'app', 'static', 'assets', 'health', 'ready', 'login', 'p', 't']);

const slugSchema = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens only')
  .refine((s) => !RESERVED_SLUGS.has(s), 'reserved slug');

const pageQuery = z.object({ cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

const createShopBody = z
  .object({
    slug: slugSchema,
    displayName: z.string().trim().min(1).max(100),
    address: z.string().trim().max(300).nullable().optional(),
    planId: z.string().min(8).max(64).optional(),
    owner: z
      .object({
        email: z.string().trim().max(254).email().transform((v) => v.toLowerCase()),
        displayName: z.string().trim().min(1).max(100),
        /** Initial password, supplied once; stored only as an Argon2id hash and never echoed or logged. */
        password: z.string().min(12).max(256)
      })
      .strict()
  })
  .strict();

const updateShopBody = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    address: z.string().trim().max(300).nullable(),
    acceptsOrders: z.boolean(),
    status: z.nativeEnum(ShopStatus)
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

const planBody = z.object({
  name: z.string().trim().min(1).max(100),
  pricePaise: z.number().int().min(0).max(100_000_000),
  active: z.boolean()
});
const createPlanBody = planBody.strict();
const updatePlanBody = planBody.partial().strict().refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

const subscriptionBody = z
  .object({
    status: z.nativeEnum(SubscriptionStatus),
    planId: z.string().min(8).max(64),
    renewsAt: z.coerce.date().nullable()
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

const shopView = (s: {
  id: string;
  slug: string;
  displayName: string;
  address: string | null;
  status: ShopStatus;
  acceptsOrders: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: s.id,
  slug: s.slug,
  displayName: s.displayName,
  address: s.address,
  status: s.status,
  acceptsOrders: s.acceptsOrders,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt
});

const subscriptionView = (
  sub: { id: string; shopId: string; status: SubscriptionStatus; renewsAt: Date | null; updatedAt: Date; plan: { id: string; name: string; pricePaise: number } } | null
) =>
  sub
    ? {
        id: sub.id,
        shopId: sub.shopId,
        status: sub.status,
        renewsAt: sub.renewsAt,
        updatedAt: sub.updatedAt,
        plan: { id: sub.plan.id, name: sub.plan.name, pricePaise: sub.plan.pricePaise }
      }
    : null;

interface PriceSnapshotMeta { selectedPageCount?: number }
interface OptionsSnapshotMeta { paperSize?: string; colourMode?: string; sides?: string; copies?: number; pageSelection?: unknown }

/**
 * Operational metadata only. Deliberately omits the customer's original filename, the storage object key, the
 * tracking token, document URLs and any content: PLATFORM_ADMIN must never be able to open a customer document through this API.
 */
const adminOrderView = (o: Order & { document: Document; shop: { slug: string; displayName: string } }) => {
  const price = (o.priceSnapshot ?? {}) as PriceSnapshotMeta;
  const opts = (o.printOptionsSnapshot ?? {}) as OptionsSnapshotMeta;
  return {
    id: o.id,
    shopId: o.shopId,
    shopSlug: o.shop.slug,
    shopName: o.shop.displayName,
    orderNumber: o.orderNumber,
    status: o.status,
    customerDisplayNameOrReference: o.customerDisplayNameOrReference,
    totalPaise: o.totalPaise,
    currency: o.currency,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    mimeType: o.document.detectedMimeType,
    pageCount: o.document.pageCount,
    selectedPageCount: price.selectedPageCount ?? null,
    paperSize: opts.paperSize ?? null,
    colourMode: opts.colourMode ?? null,
    sides: opts.sides ?? null,
    copies: opts.copies ?? null,
    pageSelection: opts.pageSelection ?? null,
    documentStatus: o.document.status,
    printedAt: o.document.printedAt,
    printInitiatedAt: o.document.printInitiatedAt,
    deleteAfter: o.document.deleteAfter,
    deletedAt: o.document.deletedAt
  };
};

/**
 * Platform admin API. Deliberately exposes NO documents, storage keys or document URLs; only metadata
 * and usage counters.
 */
export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_ADMIN_READ_MAX * 5));
  app.addHook('preHandler', adminGuard(ctx));

  app.get('/admin/dashboard', { preHandler: limits.adminRead }, async () => {
    const todayStart = startOfIstDay();
    const [shopGroups, subGroups, ordersToday, totalShops, totalOrders, orderGroups, pageRows, recentShops, recentOrders] = await Promise.all([
      prisma.shop.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.order.count({ where: { createdAt: { gte: todayStart, lt: endOfIstDay() } } }),
      prisma.shop.count(),
      prisma.order.count(),
      prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      // Pages = sum(selectedPageCount x copies) over orders that are not cancelled/expired (same rule as shop analytics).
      prisma.$queryRaw<Array<{ pages: bigint | number | null }>>`
        SELECT COALESCE(SUM(("priceSnapshot"->>'selectedPageCount')::int * COALESCE(("printOptionsSnapshot"->>'copies')::int, 1)), 0) AS pages
        FROM "Order" WHERE status NOT IN ('CANCELLED', 'EXPIRED')`,
      prisma.shop.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5, include: { subscription: { include: { plan: true } } } }),
      prisma.order.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
        include: { document: true, shop: { select: { slug: true, displayName: true } } }
      })
    ]);
    const ordersByStatus = Object.fromEntries(Object.values(OrderStatus).map((s) => [s, 0])) as Record<string, number>;
    for (const g of orderGroups) ordersByStatus[g.status] = g._count._all;
    const shopsByStatus = Object.fromEntries(Object.values(ShopStatus).map((s) => [s, 0])) as Record<string, number>;
    for (const g of shopGroups) shopsByStatus[g.status] = g._count._all;
    const subscriptionsByStatus = Object.fromEntries(Object.values(SubscriptionStatus).map((s) => [s, 0])) as Record<string, number>;
    for (const g of subGroups) subscriptionsByStatus[g.status] = g._count._all;
    return json({
      timezone: 'Asia/Kolkata',
      totalShops,
      shopsByStatus,
      activeSubscriptions: subscriptionsByStatus.ACTIVE ?? 0,
      subscriptionsByStatus,
      ordersToday,
      totalOrders,
      ordersByStatus,
      totalPages: Number(pageRows[0]?.pages ?? 0),
      recentShops: recentShops.map((s) => ({ ...shopView(s), subscription: subscriptionView(s.subscription) })),
      recentOrders: recentOrders.map(adminOrderView)
    });
  });

  /** Cross-shop order list: safe operational metadata only (see adminOrderView). */
  app.get('/admin/orders', { preHandler: limits.adminRead }, async (request) => {
    const q = pageQuery
      .extend({ shopId: z.string().min(8).max(64).optional(), status: z.nativeEnum(OrderStatus).optional() })
      .strict()
      .parse(request.query);
    const rows = await prisma.order.findMany({
      where: { shopId: q.shopId, status: q.status, ...cursorWhere(decodeCursor(q.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { document: true, shop: { select: { slug: true, displayName: true } } }
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return json({
      items: page.map(adminOrderView),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined
    });
  });

  app.get('/admin/shops', { preHandler: limits.adminRead }, async (request) => {
    const q = pageQuery
      .extend({ status: z.nativeEnum(ShopStatus).optional(), q: z.string().trim().max(100).optional() })
      .strict()
      .parse(request.query);
    // Search and cursor each use OR; combine under AND so neither overwrites the other.
    const search: Prisma.ShopWhereInput = q.q
      ? { OR: [{ slug: { contains: q.q.toLowerCase() } }, { displayName: { contains: q.q, mode: 'insensitive' } }] }
      : {};
    const where: Prisma.ShopWhereInput = {
      status: q.status,
      AND: [search, cursorWhere(decodeCursor(q.cursor))]
    };
    const rows = await prisma.shop.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: {
        subscription: { include: { plan: true } },
        users: { where: { role: Role.SHOP_OWNER }, select: { displayName: true, email: true }, orderBy: { createdAt: 'asc' }, take: 1 },
        _count: { select: { orders: true } }
      }
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    const lastOrders = await prisma.order.groupBy({ by: ['shopId'], where: { shopId: { in: page.map((s) => s.id) } }, _max: { createdAt: true } });
    const lastOrderAt = new Map(lastOrders.map((g) => [g.shopId, g._max.createdAt]));
    return json({
      items: page.map((s) => ({
        ...shopView(s),
        subscription: subscriptionView(s.subscription),
        owner: s.users[0] ?? null,
        orderCount: s._count.orders,
        lastOrderAt: lastOrderAt.get(s.id) ?? null
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined
    });
  });

  app.post('/admin/shops', { preHandler: limits.adminMutation }, async (request, reply) => {
    const auth = authOf(request);
    const body = createShopBody.parse(request.body);
    if (body.planId) {
      const plan = await prisma.plan.findUnique({ where: { id: body.planId } });
      if (!plan) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown planId');
    }
    const passwordHash = await hashPassword(body.owner.password);
    try {
      const created = await prisma.$transaction(async (tx) => {
        const shop = await tx.shop.create({
          data: { slug: body.slug, displayName: body.displayName, address: body.address ?? null, settings: { create: {} } }
        });
        const owner = await tx.user.create({
          data: { email: body.owner.email, displayName: body.owner.displayName, passwordHash, role: Role.SHOP_OWNER, shopId: shop.id }
        });
        if (body.planId) await tx.subscription.create({ data: { shopId: shop.id, planId: body.planId } });
        await audit(tx, {
          shopId: shop.id,
          actorUserId: auth.userId,
          action: 'admin.shop.create',
          targetType: 'shop',
          targetId: shop.id,
          metadata: { slug: shop.slug, ownerUserId: owner.id, planId: body.planId ?? null }
        });
        return { shop, owner };
      });
      reply.code(201);
      return json({
        shop: shopView(created.shop),
        owner: { id: created.owner.id, email: created.owner.email, displayName: created.owner.displayName }
      });
    } catch (error) {
      if (isUniqueViolation(error, 'slug')) throw new AppError(409, 'CONFLICT', 'Slug already in use', { field: 'slug' });
      if (isUniqueViolation(error, 'email')) throw new AppError(409, 'CONFLICT', 'Email already in use', { field: 'owner.email' });
      throw error;
    }
  });

  app.get('/admin/shops/:id', { preHandler: limits.adminRead }, async (request) => {
    const { id } = idParam.parse(request.params);
    const shop = await prisma.shop.findUnique({
      where: { id },
      include: { subscription: { include: { plan: true } }, users: { select: { id: true, email: true, displayName: true, role: true } } }
    });
    if (!shop) throw notFound('Shop not found');
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [orderCount, orders30d, pricingRules, lastOrder, statusGroups, recentOrders] = await Promise.all([
      prisma.order.count({ where: { shopId: id } }),
      prisma.order.count({ where: { shopId: id, createdAt: { gte: since } } }),
      prisma.pricingRule.findMany({ where: { shopId: id }, orderBy: [{ colourMode: 'asc' }, { sides: 'asc' }] }),
      prisma.order.findFirst({ where: { shopId: id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.order.groupBy({ by: ['status'], where: { shopId: id }, _count: { _all: true } }),
      prisma.order.findMany({
        where: { shopId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        include: { document: true, shop: { select: { slug: true, displayName: true } } }
      })
    ]);
    const ordersByStatus = Object.fromEntries(Object.values(OrderStatus).map((st) => [st, 0])) as Record<string, number>;
    for (const g of statusGroups) ordersByStatus[g.status] = g._count._all;
    return json({
      shop: shopView(shop),
      owners: shop.users,
      subscription: subscriptionView(shop.subscription),
      usage: { orderCount, ordersLast30Days: orders30d, pricingRuleCount: pricingRules.length, lastOrderAt: lastOrder?.createdAt ?? null },
      ordersByStatus,
      pricingRules: pricingRules.map((r) => ({
        id: r.id,
        paperSize: r.paperSize,
        colourMode: r.colourMode,
        sides: r.sides,
        pricePerSheetPaise: r.pricePerSheetPaise,
        active: r.active
      })),
      recentOrders: recentOrders.map(adminOrderView)
    });
  });

  app.put('/admin/shops/:id', { preHandler: limits.adminMutation }, async (request) => {
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    const body = updateShopBody.parse(request.body);
    const shop = await prisma.$transaction(async (tx) => {
      const before = await tx.shop.findUnique({ where: { id } });
      if (!before) throw notFound('Shop not found');
      const updated = await tx.shop.update({ where: { id }, data: body });
      if (body.status === ShopStatus.SUSPENDED) {
        // Immediate lock-out of every shop session.
        await tx.session.updateMany({ where: { user: { shopId: id }, invalidatedAt: null }, data: { invalidatedAt: new Date() } });
      }
      await audit(tx, {
        shopId: id,
        actorUserId: auth.userId,
        action: body.status && body.status !== before.status ? `admin.shop.${body.status === 'SUSPENDED' ? 'suspend' : 'activate'}` : 'admin.shop.update',
        targetType: 'shop',
        targetId: id,
        metadata: { fields: Object.keys(body), statusFrom: before.status, statusTo: updated.status }
      });
      return updated;
    });
    return json({ shop: shopView(shop) });
  });

  app.get('/admin/plans', { preHandler: limits.adminRead }, async () => {
    const plans = await prisma.plan.findMany({ orderBy: { createdAt: 'asc' } });
    return json(plans.map((p) => ({ id: p.id, name: p.name, pricePaise: p.pricePaise, active: p.active, updatedAt: p.updatedAt })));
  });

  app.post('/admin/plans', { preHandler: limits.adminMutation }, async (request, reply) => {
    const auth = authOf(request);
    const body = createPlanBody.parse(request.body);
    try {
      const plan = await prisma.$transaction(async (tx) => {
        const created = await tx.plan.create({ data: body });
        await audit(tx, { shopId: null, actorUserId: auth.userId, action: 'admin.plan.create', targetType: 'plan', targetId: created.id, metadata: body });
        return created;
      });
      reply.code(201);
      return json({ id: plan.id, name: plan.name, pricePaise: plan.pricePaise, active: plan.active });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'CONFLICT', 'Plan name already exists', { field: 'name' });
      throw error;
    }
  });

  app.put('/admin/plans/:id', { preHandler: limits.adminMutation }, async (request) => {
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    const body = updatePlanBody.parse(request.body);
    try {
      const plan = await prisma.$transaction(async (tx) => {
        const updated = await tx.plan.updateMany({ where: { id }, data: body });
        if (updated.count !== 1) throw notFound('Plan not found');
        await audit(tx, { shopId: null, actorUserId: auth.userId, action: 'admin.plan.update', targetType: 'plan', targetId: id, metadata: body });
        return tx.plan.findUniqueOrThrow({ where: { id } });
      });
      return json({ id: plan.id, name: plan.name, pricePaise: plan.pricePaise, active: plan.active });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'CONFLICT', 'Plan name already exists', { field: 'name' });
      throw error;
    }
  });

  app.get('/admin/subscriptions', { preHandler: limits.adminRead }, async (request) => {
    const q = pageQuery.extend({ status: z.nativeEnum(SubscriptionStatus).optional() }).strict().parse(request.query);
    const rows = await prisma.subscription.findMany({
      where: { status: q.status, ...cursorWhere(decodeCursor(q.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { plan: true, shop: { select: { slug: true, displayName: true, status: true } } }
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return json({
      items: page.map((s) => ({ ...subscriptionView(s), shop: s.shop })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined
    });
  });

  /** `:id` is the SHOP id: one subscription per shop. Creates the subscription if absent (planId required then). */
  app.put('/admin/subscriptions/:id', { preHandler: limits.adminMutation }, async (request) => {
    const auth = authOf(request);
    const { id: shopId } = idParam.parse(request.params);
    const body = subscriptionBody.parse(request.body);
    const sub = await prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ where: { id: shopId } });
      if (!shop) throw notFound('Shop not found');
      if (body.planId && !(await tx.plan.findUnique({ where: { id: body.planId } }))) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Unknown planId');
      }
      const existing = await tx.subscription.findUnique({ where: { shopId } });
      let saved;
      if (existing) {
        saved = await tx.subscription.update({ where: { shopId }, data: body, include: { plan: true } });
      } else {
        if (!body.planId) throw new AppError(400, 'VALIDATION_ERROR', 'planId is required to create a subscription');
        saved = await tx.subscription.create({
          data: { shopId, planId: body.planId, status: body.status ?? 'ACTIVE', renewsAt: body.renewsAt ?? null },
          include: { plan: true }
        });
      }
      await audit(tx, {
        shopId,
        actorUserId: auth.userId,
        action: 'admin.subscription.update',
        targetType: 'subscription',
        targetId: saved.id,
        metadata: { status: saved.status, planId: saved.planId, renewsAt: saved.renewsAt?.toISOString() ?? null }
      });
      return saved;
    });
    return json(subscriptionView(sub));
  });

  app.get('/admin/audit-logs', { preHandler: limits.adminRead }, async (request) => {
    const q = pageQuery
      .extend({ shopId: z.string().min(8).max(64).optional(), action: z.string().max(100).optional() })
      .strict()
      .parse(request.query);
    const rows = await prisma.auditLog.findMany({
      where: { shopId: q.shopId, action: q.action, ...cursorWhere(decodeCursor(q.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return json({
      items: page.map((a) => ({
        id: a.id,
        shopId: a.shopId,
        actorUserId: a.actorUserId,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        metadata: a.metadata,
        createdAt: a.createdAt
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined
    });
  });
}
