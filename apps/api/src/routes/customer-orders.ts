import { randomBytes } from 'node:crypto';
import { DocumentStatus, OrderStatus, type Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { quoteSecret } from '../config.js';
import { subscriptionAllowsIntake } from '../domain/eligibility.js';
import { assertAcceptingByHours } from '../domain/hours-view.js';
import { createOrderFromQuote } from '../domain/order-create.js';
import { apiPaymentMethod, apiPaymentStatus, dbPaymentMethod, normaliseUpiRef, paymentLocksStatusChange, submitUpiReference, UPI_REF } from '../domain/payments.js';
import { MAX_TOTAL_PAISE, pageSelectionSchema, quote } from '../domain/pricing.js';
import { signQuote, verifyQuote } from '../domain/quote-token.js';
import { AppError, orderNotFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { deriveSecret, generateObjectKey } from '../storage/index.js';
import { sanitizeFilename } from '../storage/filename.js';
import { ACCEPTED_MIME_TYPES, UPLOADING_RECLAIM_MS, UPLOAD_TOKEN_TTL_SECONDS, uploadToken } from '../uploads.js';
import { audit, authOf, customerGuard, json, type AppContext } from './context.js';

/** Presigned uploads per customer per hour (PDF rate limit); counted from the database so it survives restarts and multiple processes. */
export const CUSTOMER_UPLOADS_PER_HOUR = 50;
export const MAX_CUSTOMER_COPIES = 50;
export const MAX_NOTE_LENGTH = 500;

const idSchema = z.string().min(8).max(64);
const presignBody = z
  .object({ shopId: idSchema, fileName: z.string().min(1).max(255), byteSize: z.number().int().min(0), declaredMimeType: z.enum(ACCEPTED_MIME_TYPES) })
  .strict();

/**
 * Customer print preferences (decision D2): per-sheet pricing exactly as the guest flow. A4 on plain paper is the only combination
 * priced today, so any other paper size or type is refused instead of being quoted at a price that does not exist.
 */
const customerPrintOptions = z
  .object({
    paperSize: z.literal('A4'),
    paperType: z.literal('normal').optional(),
    colourMode: z.enum(['bw', 'colour']),
    sides: z.enum(['single', 'duplex']),
    copies: z.number().int().min(1).max(MAX_CUSTOMER_COPIES),
    pageSelection: pageSelectionSchema
  })
  .strict();
const quoteBody = z.object({ shopId: idSchema, documentId: idSchema, printOptions: customerPrintOptions }).strict();
const orderBody = z
  .object({ quoteId: z.string().min(1).max(4096), clientRequestId: z.string().uuid().optional(), note: z.string().trim().max(MAX_NOTE_LENGTH).optional(), paymentMethod: z.enum(['cash', 'upi']) })
  .strict();
const orderParam = z.object({ id: idSchema }).strict();
const listQuery = z
  .object({
    status: z.nativeEnum(OrderStatus).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20)
  })
  .strict();
const paymentBody = z.object({ upiTxnRef: z.string().trim().regex(UPI_REF, 'Enter the UPI transaction reference (8-22 letters or digits)') }).strict();
const cancelBody = z.object({ cancelReason: z.string().trim().max(200).optional() }).strict();

type OrderRow = Prisma.OrderGetPayload<{ include: { shop: { select: { displayName: true, upiId: true } }; document: true } }>;

const actorLabel = (actorUserId: string | null, actorDeviceId: string | null, customerUserId: string | null): 'customer' | 'shop' | 'system' =>
  actorUserId && actorUserId === customerUserId ? 'customer' : actorUserId || actorDeviceId ? 'shop' : 'system';

/** What the customer sees: no tracking token, no actor ids, no storage keys. */
const customerOrderView = (o: OrderRow) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  shopId: o.shopId,
  shopName: o.shop.displayName,
  status: o.status,
  totalPaise: o.totalPaise,
  currency: o.currency,
  printOptions: o.printOptionsSnapshot,
  priceSnapshot: o.priceSnapshot,
  fileName: o.document.originalFilename,
  pages: o.document.pageCount,
  fileDeletedAt: o.document.deletedAt,
  payment: {
    method: apiPaymentMethod(o.paymentMethod),
    status: apiPaymentStatus(o.paymentStatus),
    upiTxnRef: o.upiTxnRef,
    /** Where to pay: only for UPI orders. */
    upiId: o.paymentMethod === 'UPI' ? o.shop.upiId : null
  },
  note: o.note,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt
});

/**
 * Customer ordering (schema-v2 phase 3; NEW routes, customer session only). Reuses the existing upload pipeline (token-protected PUT and
 * the page-count/type validation at completion), the existing pricing engine and the shared order-creation transaction. Every document
 * and order is bound to the authenticated customer; another customer's id, quote or clientRequestId reveals nothing (404/422/409).
 */
export async function customerOrderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, events } = ctx;
  const limits = getLimiters(app, config);
  const guard = customerGuard(ctx);
  const secret = deriveSecret(config, 'upload-token');
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** A shop customers may order from right now: verified, ACTIVE, owner switch on, intake allowed. Hours are checked by the callers. */
  async function orderableShop(shopId: string) {
    const shop = await prisma.shop.findFirst({ where: { id: shopId, isVerified: true, status: 'ACTIVE' }, include: { settings: true, subscription: { select: { status: true } } } });
    if (!shop) throw new AppError(404, 'SHOP_NOT_FOUND', 'Shop not found');
    if (!shop.acceptsOrders || !subscriptionAllowsIntake(shop.subscription)) throw new AppError(409, 'SHOP_UNAVAILABLE', 'This shop is not accepting orders right now');
    return shop;
  }

  // ---- uploads -----------------------------------------------------------------------------------------------------------------

  app.post('/customer/uploads', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const body = presignBody.parse(request.body);
    const shop = await orderableShop(body.shopId);
    assertAcceptingByHours(shop.settings);
    if (body.byteSize === 0) throw new AppError(422, 'EMPTY_FILE', 'The file is empty');
    if (body.byteSize > config.UPLOAD_MAX_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size', { maxBytes: config.UPLOAD_MAX_BYTES });
    const since = new Date(Date.now() - 3_600_000);
    if ((await prisma.document.count({ where: { uploaderUserId: auth.userId, createdAt: { gt: since } } })) >= CUSTOMER_UPLOADS_PER_HOUR) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many uploads. Try again later.');
    }
    const key = generateObjectKey();
    const now = Date.now();
    const doc = await prisma.document.create({
      data: {
        id: randomBytes(18).toString('base64url'),
        shopId: shop.id,
        uploaderUserId: auth.userId,
        objectKey: key,
        originalFilename: sanitizeFilename(body.fileName),
        detectedMimeType: body.declaredMimeType,
        byteSize: BigInt(body.byteSize),
        status: DocumentStatus.UPLOADING,
        expiresAt: new Date(now + UPLOADING_RECLAIM_MS)
      }
    });
    const exp = Math.floor(now / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
    const base = (config.PUBLIC_API_BASE ?? '').replace(/\/$/, '');
    return json({
      uploadId: doc.id,
      uploadUrl: `${base}/api/v1/public/uploads/${doc.id}/content?token=${uploadToken(secret, doc.id, key, exp)}`,
      requiredHeaders: { 'content-type': body.declaredMimeType },
      /** After the PUT, POST here (no body) to validate the file and learn its page count. */
      completePath: `/public/shops/${shop.slug}/uploads/${doc.id}/complete`,
      expiresAt: new Date(exp * 1000),
      limits: { acceptedMimeTypes: [...ACCEPTED_MIME_TYPES], maxBytes: config.UPLOAD_MAX_BYTES, maxPdfPages: config.UPLOAD_MAX_PDF_PAGES, imagePageCount: 1 }
    });
  });

  // ---- quotes ------------------------------------------------------------------------------------------------------------------

  app.post('/customer/quotes', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const body = quoteBody.parse(request.body);
    const shop = await orderableShop(body.shopId);
    assertAcceptingByHours(shop.settings);
    const now = new Date();
    const doc = await prisma.document.findFirst({
      where: { id: body.documentId, shopId: shop.id, uploaderUserId: auth.userId, status: DocumentStatus.AVAILABLE, expiresAt: { gt: now }, order: { is: null } }
    });
    if (!doc || !doc.pageCount) throw new AppError(422, 'DOCUMENT_UNAVAILABLE', 'Printable document not found');
    const { paperType: _paperType, ...options } = body.printOptions;
    const rules = await prisma.pricingRule.findMany({ where: { shopId: shop.id, active: true } });
    const result = quote(options, doc.pageCount, rules.map((r) => ({ ...r, paperSize: 'A4' as const })));
    if (result.totalPaise > MAX_TOTAL_PAISE) throw new AppError(422, 'DOCUMENT_UNAVAILABLE', 'Order too large');
    const expiresAt = new Date(now.getTime() + config.QUOTE_TTL_SECONDS * 1000);
    const quoteId = signQuote(quoteSecret(config), { documentId: doc.id, shopId: shop.id, printOptions: result.printOptions, expiresAt: expiresAt.getTime() });
    return json({ quoteId, shopId: shop.id, ...result, expiresAt });
  });

  // ---- orders ------------------------------------------------------------------------------------------------------------------

  const clientRequestIdOf = (request: FastifyRequest, bodyId: string | undefined): string => {
    const header = request.headers['idempotency-key'];
    const fromHeader = typeof header === 'string' ? header.trim() : undefined;
    if (fromHeader !== undefined && !z.string().uuid().safeParse(fromHeader).success) throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be a UUID', { field: 'Idempotency-Key' });
    if (fromHeader && bodyId && fromHeader !== bodyId) throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key and clientRequestId differ', { field: 'clientRequestId' });
    const id = bodyId ?? fromHeader;
    if (!id) throw new AppError(400, 'VALIDATION_ERROR', 'Send an Idempotency-Key header or clientRequestId (UUID)', { field: 'clientRequestId' });
    return id;
  };

  app.post('/customer/orders', { preHandler: [guard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const body = orderBody.parse(request.body);
    const clientRequestId = clientRequestIdOf(request, body.clientRequestId);
    const payload = verifyQuote(quoteSecret(config), body.quoteId);
    const shop = await orderableShop(payload.shopId);
    const method = dbPaymentMethod(body.paymentMethod);
    if (!shop.acceptedPaymentMethods.includes(method) || (method === 'UPI' && !shop.upiId)) {
      throw new AppError(400, 'PAYMENT_METHOD_NOT_ACCEPTED', 'This shop does not accept that payment method', { field: 'paymentMethod' });
    }
    const order = await createOrderFromQuote(ctx, { shop, payload, clientRequestId, customerUserId: auth.userId, note: body.note ?? null, paymentMethod: method });
    const full = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { shop: { select: { displayName: true, upiId: true } }, document: true } });
    reply.code(201);
    return json(customerOrderView(full));
  });

  app.get('/customer/orders', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const auth = authOf(request);
    const q = listQuery.parse(request.query);
    const where: Prisma.OrderWhereInput = { customerUserId: auth.userId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, include: { shop: { select: { displayName: true, upiId: true } }, document: true } }),
      prisma.order.count({ where })
    ]);
    return json({ items: rows.map(customerOrderView), page: q.page, limit: q.limit, total });
  });

  app.get('/customer/orders/:id', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const auth = authOf(request);
    const { id } = orderParam.parse(request.params);
    // Another customer's order and a missing order are indistinguishable (404).
    const order = await prisma.order.findFirst({ where: { id, customerUserId: auth.userId }, include: { shop: { select: { displayName: true, upiId: true } }, document: true, histories: { orderBy: { createdAt: 'asc' } } } });
    if (!order) throw orderNotFound();
    return json({
      ...customerOrderView(order),
      statusHistory: order.histories.map((h) => ({ status: h.toStatus, by: actorLabel(h.actorUserId, h.actorDeviceId, order.customerUserId), reason: h.reason, createdAt: h.createdAt }))
    });
  });

  /** UPI orders: submit the transaction reference. A claim only; the shop verifies it. */
  app.post('/customer/orders/:id/payment', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const { id } = orderParam.parse(request.params);
    const body = paymentBody.parse(request.body);
    const updated = await submitUpiReference(prisma, { customerUserId: auth.userId, orderId: id, upiTxnRef: normaliseUpiRef(body.upiTxnRef) });
    if (!updated) throw orderNotFound();
    const full = await prisma.order.findUniqueOrThrow({ where: { id }, include: { shop: { select: { displayName: true, upiId: true } }, document: true } });
    return json(customerOrderView(full));
  });

  /** Cancel while NEW or ACCEPTED and before any print was initiated. Compare-and-set, so a concurrent shop action wins cleanly. */
  app.post('/customer/orders/:id/cancel', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const { id } = orderParam.parse(request.params);
    const body = cancelBody.parse(request.body ?? {});
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id, customerUserId: auth.userId }, include: { document: true } });
      if (!order) throw orderNotFound();
      if (order.status === OrderStatus.CANCELLED) return { order, changed: false };
      if (paymentLocksStatusChange(order.paymentStatus)) throw new AppError(409, 'PAYMENT_RECORDED', 'A payment is recorded for this order. Contact the shop to resolve it before cancelling.');
      const cancellable = (order.status === OrderStatus.NEW || order.status === OrderStatus.ACCEPTED) && !order.document.printInitiatedAt;
      if (!cancellable) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This order can no longer be cancelled', { from: order.status, to: 'CANCELLED' });
      const updated = await tx.order.updateMany({ where: { id, status: order.status }, data: { status: OrderStatus.CANCELLED } });
      if (updated.count !== 1) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Order status changed concurrently; reload and retry');
      await tx.orderStatusHistory.create({ data: { orderId: id, fromStatus: order.status, toStatus: OrderStatus.CANCELLED, reason: body.cancelReason ?? null, actorUserId: auth.userId } });
      await audit(tx, { shopId: order.shopId, actorUserId: auth.userId, actorType: 'CUSTOMER', action: 'order.cancelled_by_customer', targetType: 'order', targetId: id, metadata: { from: order.status } });
      return { order: await tx.order.findUniqueOrThrow({ where: { id }, include: { document: true } }), changed: true };
    });
    if (result.changed) {
      const payload = { id: result.order.id, orderNumber: result.order.orderNumber, status: result.order.status, updatedAt: result.order.updatedAt };
      events.emit(result.order.shopId, 'order.statusChanged', payload);
      events.emit(result.order.shopId, 'order.updated', payload);
    }
    const full = await prisma.order.findUniqueOrThrow({ where: { id }, include: { shop: { select: { displayName: true, upiId: true } }, document: true } });
    return json({ ...customerOrderView(full), cancelReason: body.cancelReason ?? null });
  });
}
