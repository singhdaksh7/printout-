import { DocumentStatus, OrderStatus, type Order, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newToken } from '../auth.js';
import { quoteSecret } from '../config.js';
import { normalisePrintOptions, printOptionsSchema, quote, type QuoteResult } from '../domain/pricing.js';
import { signQuote, verifyQuote } from '../domain/quote-token.js';
import { subscriptionAllowsIntake } from '../domain/eligibility.js';
import { AppError, notFound } from '../errors.js';
import { isUniqueViolation, json, type AppContext } from './context.js';

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

function orderNumberPrefix(slug: string): string {
  const letters = slug.replace(/[^a-z0-9]/g, '').toUpperCase().slice(0, 6);
  return letters.length >= 2 ? letters : 'ORD';
}

export async function publicRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, events } = ctx;
  const limit = { rateLimit: { max: config.PUBLIC_RATE_LIMIT_MAX, timeWindow: '1 minute' } };

  /** Active (not suspended) shop by slug, or a constant 404. */
  async function activeShop(slug: string) {
    const shop = await prisma.shop.findFirst({ where: { slug, status: 'ACTIVE' }, include: { settings: true, subscription: { select: { status: true } } } });
    if (!shop) throw notFound('Shop not found');
    return shop;
  }

  async function orderingShop(slug: string) {
    const shop = await activeShop(slug);
    if (!shop.acceptsOrders || !subscriptionAllowsIntake(shop.subscription)) throw new AppError(409, 'SHOP_UNAVAILABLE', 'This shop is not accepting orders right now');
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
      where: { id: body.documentId, shopId: shop.id, status: DocumentStatus.AVAILABLE, expiresAt: { gt: now }, order: { is: null } }
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
    const shop = await orderingShop(slug);

    const payload = verifyQuote(quoteSecret(config), body.quoteId);
    if (payload.shopId !== shop.id) throw new AppError(422, 'INVALID_QUOTE', 'Quote is invalid');

    // Idempotent retry: same clientRequestId returns the original order.
    const existing = await prisma.order.findUnique({
      where: { shopId_clientRequestId: { shopId: shop.id, clientRequestId: body.clientRequestId } }
    });
    if (existing) {
      if (existing.documentId !== payload.documentId) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'clientRequestId was already used for a different order');
      }
      return orderResponse(existing);
    }

    const now = new Date();
    const doc = await prisma.document.findFirst({ where: { id: payload.documentId, shopId: shop.id }, include: { order: { select: { id: true } } } });
    if (!doc) throw new AppError(422, 'DOCUMENT_UNAVAILABLE', 'Document is no longer available');
    if (doc.order) {
      const original = await prisma.order.findUnique({
        where: { shopId_clientRequestId: { shopId: shop.id, clientRequestId: body.clientRequestId } }
      });
      if (original?.documentId === doc.id) return orderResponse(original);
      throw new AppError(409, 'DOCUMENT_ALREADY_USED', 'This document already has an order');
    }
    if (doc.status !== DocumentStatus.AVAILABLE || !doc.expiresAt || doc.expiresAt <= now || !doc.pageCount) {
      throw new AppError(422, 'DOCUMENT_UNAVAILABLE', 'Document is no longer available');
    }

    // Authoritative recalculation with the shop's CURRENT active rules; nothing price-like is trusted from the token.
    const rules = await prisma.pricingRule.findMany({ where: { shopId: shop.id, active: true } });
    const result: QuoteResult = quote(
      normalisePrintOptions(payload.printOptions, doc.pageCount),
      doc.pageCount,
      rules.map((r) => ({ ...r, paperSize: 'A4' as const }))
    );

    try {
      const order = await prisma.$transaction(async (tx) => {
        const claimed = await tx.document.updateMany({
          where: { id: doc.id, shopId: shop.id, status: DocumentStatus.AVAILABLE, expiresAt: { gt: now }, order: { is: null } },
          data: { updatedAt: now }
        });
        if (claimed.count !== 1) throw new AppError(409, 'DOCUMENT_ALREADY_USED', 'This document already has an order');
        // Row-locking counter => collision-free, human-readable per-shop sequence (e.g. CENTRA-0001).
        const { orderCounter } = await tx.shop.update({
          where: { id: shop.id },
          data: { orderCounter: { increment: 1 } },
          select: { orderCounter: true }
        });
        return tx.order.create({
          data: {
            shopId: shop.id,
            documentId: doc.id,
            orderNumber: `${orderNumberPrefix(shop.slug)}-${String(orderCounter).padStart(4, '0')}`,
            trackingToken: newToken(),
            clientRequestId: body.clientRequestId,
            customerDisplayNameOrReference: body.customerDisplayNameOrReference || null,
            totalPaise: result.totalPaise,
            priceSnapshot: result as unknown as Prisma.InputJsonValue,
            printOptionsSnapshot: result.printOptions as unknown as Prisma.InputJsonValue,
            histories: { create: { toStatus: OrderStatus.NEW } }
          }
        });
      });
      events.emit(shop.id, 'order.created', {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        updatedAt: order.updatedAt
      });
      try {
        // Fire-and-forget device signal (order id only); must never affect the customer response.
        ctx.notifier.notifyNewPrintRequest(shop.id, order.id);
      } catch {
        /* ignored */
      }
      return orderResponse(order);
    } catch (error) {
      const raceLost =
        isUniqueViolation(error, 'clientRequestId') ||
        isUniqueViolation(error, 'documentId') ||
        (error instanceof AppError && error.code === 'DOCUMENT_ALREADY_USED');
      if (raceLost) {
        // A concurrent request with the same clientRequestId may have won: return its order.
        const original = await prisma.order.findUnique({
          where: { shopId_clientRequestId: { shopId: shop.id, clientRequestId: body.clientRequestId } }
        });
        if (original) {
          if (original.documentId === doc.id) return orderResponse(original);
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'clientRequestId was already used for a different order');
        }
        throw new AppError(409, 'DOCUMENT_ALREADY_USED', 'This document already has an order');
      }
      throw error;
    }
  });

  app.get('/public/orders/:token', { config: limit }, async (request) => {
    const parsed = trackingParam.safeParse(request.params);
    // Malformed and unknown tokens are indistinguishable.
    const order = parsed.success
      ? await prisma.order.findUnique({
          where: { trackingToken: parsed.data.token },
          include: { shop: { select: { displayName: true, slug: true } }, document: true, histories: { orderBy: { createdAt: 'asc' } } }
        })
      : null;
    if (!order) throw notFound('Order not found');
    const price = order.priceSnapshot as { selectedPageCount?: number };
    return json({
      serverTime: new Date(),
      retentionMinutes: config.PRINT_RETENTION_MINUTES,
      shopSlug: order.shop.slug,
      orderNumber: order.orderNumber,
      shopName: order.shop.displayName,
      status: order.status,
      totalPaise: order.totalPaise,
      currency: order.currency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      printOptions: order.printOptionsSnapshot,
      selectedPageCount: price.selectedPageCount ?? null,
      document: {
        fileName: order.document.originalFilename,
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
