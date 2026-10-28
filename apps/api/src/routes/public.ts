import { DocumentStatus, type Order } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { quoteSecret } from '../config.js';
import { printOptionsSchema, quote } from '../domain/pricing.js';
import { createOrderFromQuote } from '../domain/order-create.js';
import { signQuote, verifyQuote } from '../domain/quote-token.js';
import { subscriptionAllowsIntake } from '../domain/eligibility.js';
import { ATTENTION_JOB_STATUSES } from '../domain/order-serializers.js';
import { assertAcceptingByHours, publicAvailability } from '../domain/hours-view.js';
import { AppError, notFound } from '../errors.js';
import { json, type AppContext } from './context.js';

const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{3,80}$/) });

const quoteBody = z.object({ documentId: z.string().min(8).max(64), printOptions: printOptionsSchema }).strict();

const orderBody = z
  .object({
    quoteId: z.string().min(1).max(4096),
    customerDisplayNameOrReference: z.string().trim().max(100).optional(),
    clientRequestId: z.string().uuid()
  })
  .strict();

const trackingParam = z.object({ token: z.string().min(1).max(200) });

export async function publicRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limit = { rateLimit: { max: config.PUBLIC_RATE_LIMIT_MAX, timeWindow: '1 minute' } };

  /** Active (not suspended) shop by slug, or a constant 404. */
  async function activeShop(slug: string) {
    const shop = await prisma.shop.findFirst({ where: { slug, status: 'ACTIVE' }, include: { settings: true, subscription: { select: { status: true } } } });
    if (!shop) throw notFound('Shop not found');
    return shop;
  }

  /** `hours: false` defers the operating-hours gate (orders re-check it after idempotent replays and inside the transaction). */
  async function orderingShop(slug: string, opts: { hours?: boolean } = {}) {
    const shop = await activeShop(slug);
    if (!shop.acceptsOrders || !subscriptionAllowsIntake(shop.subscription)) throw new AppError(409, 'SHOP_UNAVAILABLE', 'This shop is not accepting orders right now');
    if (opts.hours !== false) assertAcceptingByHours(shop.settings);
    return shop;
  }

  app.get('/public/shops/:slug', { config: limit }, async (request) => {
    const { slug } = slugParam.parse(request.params);
    const found = await prisma.shop.findUnique({ where: { slug }, include: { settings: true, subscription: { select: { status: true } } } });
    if (!found) throw notFound('Shop not found');
    if (found.status !== 'ACTIVE') {
      // No private data for suspended shops; the customer UI can show a clear "unavailable" state.
      return json({ slug: found.slug, displayName: found.displayName, status: found.status, acceptsOrders: false, retentionMinutes: config.PRINT_RETENTION_MINUTES });
    }
    const shop = found;
    return json({
      status: shop.status,
      slug: shop.slug,
      displayName: shop.displayName,
      address: shop.address,
      publicContact: shop.settings?.publicContact ?? null,
      acceptsOrders: shop.acceptsOrders && subscriptionAllowsIntake(shop.subscription),
      // Server-computed from authoritative settings; clients must not derive open/closed from their own clock.
      availability: publicAvailability(shop.settings),
      retentionMinutes: config.PRINT_RETENTION_MINUTES,
      branding: shop.settings ? { brandColor: shop.settings.brandColor } : undefined,
      printCapabilities: { paperSizes: ['A4'], colourModes: ['bw', 'colour'], sides: ['single', 'duplex'] }
    });
  });

  app.post('/public/shops/:slug/quotes', { config: limit }, async (request) => {
    const { slug } = slugParam.parse(request.params);
    const body = quoteBody.parse(request.body);
    const shop = await orderingShop(slug);
    const now = new Date();
    const doc = await prisma.document.findFirst({
      where: { id: body.documentId, shopId: shop.id, uploaderUserId: null, status: DocumentStatus.AVAILABLE, expiresAt: { gt: now }, order: { is: null } }
    });
    if (!doc || !doc.pageCount) throw new AppError(422, 'DOCUMENT_UNAVAILABLE', 'Printable document not found');
    const rules = await prisma.pricingRule.findMany({ where: { shopId: shop.id, active: true } });
    const result = quote(body.printOptions, doc.pageCount, rules.map((r) => ({ ...r, paperSize: 'A4' as const })));
    const expiresAt = new Date(now.getTime() + config.QUOTE_TTL_SECONDS * 1000);
    const quoteId = signQuote(quoteSecret(config), {
      documentId: doc.id,
      shopId: shop.id,
      printOptions: result.printOptions,
      expiresAt: expiresAt.getTime()
    });
    return json({ quoteId, ...result, expiresAt });
  });

  const orderResponse = (order: Pick<Order, 'orderNumber' | 'trackingToken' | 'status' | 'totalPaise' | 'currency'>) =>
    json({
      orderNumber: order.orderNumber,
      trackingToken: order.trackingToken,
      status: order.status,
      totalPaise: order.totalPaise,
      currency: order.currency
    });

  app.post('/public/shops/:slug/orders', { config: limit }, async (request) => {
    const { slug } = slugParam.parse(request.params);
    const body = orderBody.parse(request.body);
    const shop = await orderingShop(slug, { hours: false });

    const payload = verifyQuote(quoteSecret(config), body.quoteId);
    if (payload.shopId !== shop.id) throw new AppError(422, 'INVALID_QUOTE', 'Quote is invalid');

    const order = await createOrderFromQuote(ctx, {
      shop,
      payload,
      clientRequestId: body.clientRequestId,
      customerDisplayNameOrReference: body.customerDisplayNameOrReference || null
    });
    return orderResponse(order);
  });

  app.get('/public/orders/:token', { config: limit }, async (request) => {
    const parsed = trackingParam.safeParse(request.params);
    // Malformed and unknown tokens are indistinguishable.
    const order = parsed.success
      ? await prisma.order.findUnique({
          where: { trackingToken: parsed.data.token },
          include: { shop: { select: { displayName: true, slug: true, address: true, settings: { select: { publicContact: true } } } }, document: true, histories: { orderBy: { createdAt: 'asc' } } }
        })
      : null;
    if (!order) throw notFound('Order not found');
    const price = order.priceSnapshot as { selectedPageCount?: number };
    // Coarse, customer-safe signal only: the LATEST print job needs the shop's attention. No printer, device or error detail.
    const lastJob = ['CANCELLED', 'EXPIRED', 'COLLECTED'].includes(order.status)
      ? null
      : await prisma.devicePrintJob.findFirst({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    const printIssue = !!lastJob && ATTENTION_JOB_STATUSES.includes(lastJob.status);
    const fileGone = order.document.status === DocumentStatus.DELETED;
    return json({
      serverTime: new Date(),
      retentionMinutes: config.PRINT_RETENTION_MINUTES,
      shopSlug: order.shop.slug,
      orderNumber: order.orderNumber,
      shopName: order.shop.displayName,
      pickup: { address: order.shop.address, contact: order.shop.settings?.publicContact ?? null },
      printIssue,
      status: order.status,
      totalPaise: order.totalPaise,
      currency: order.currency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      printOptions: order.printOptionsSnapshot,
      selectedPageCount: price.selectedPageCount ?? null,
      document: {
        fileName: fileGone ? null : order.document.originalFilename,
        pageCount: order.document.pageCount,
        status: order.document.status,
        deleteAfter: order.document.deleteAfter,
        deletedAt: order.document.deletedAt
      },
      documentDeleteAfter: order.document.deleteAfter,
      timeline: order.histories.map((h) => ({ status: h.toStatus, at: h.createdAt }))
    });
  });
}
