import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { OrderStatus, Role, ShopStatus, type Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth.js';
import { pushCustomerNotification } from '../domain/customer-notifications.js';
import { customerImagePath, SUPPORTED_PAPER_TYPES } from '../domain/discovery.js';
import { shopChangeStatus } from '../domain/order-transition.js';
import { apiPaymentMethod, apiPaymentStatus, dbPaymentMethod, setPaymentByShop, UPI_ID } from '../domain/payments.js';
import { listOwnedShops, requireOwnedShop } from '../domain/shop-access.js';
import { AppError, orderNotFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { adminGuard, assertCsrf, audit, authenticate, authOf, isUniqueViolation, type AppContext } from '../routes/context.js';
import { MAX_SHOP_IMAGES, MAX_SHOP_IMAGE_BYTES, sniffImage } from '../routes/shop-profile.js';
import { generateObjectKey } from '../storage/index.js';
import { forward, pageQuery, paginated, pdfOnly, pdfTwin } from './facade.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    pdf?: boolean;
  }
}

/**
 * PDF contract routes for shop owners and admins (printout_buddy_schema.pdf pages 15-19).
 * See contract/facade.ts for how the contract is selected (`X-API-Contract: pdf` twins vs PDF-only paths) and how errors are shaped.
 *
 * APPROVED DIFFERENCES FROM THE PDF (do not change):
 *  - upload size stays 50 MiB and retention stays 30 minutes (neither is touched by these routes);
 *  - pricing is server-authoritative PER SHEET with correct duplex handling (see "rates mapping" below);
 *  - payments are customer cash/UPI tracking; refunds are admin-only and manual (`refunded` is set only by POST /admin/orders/:id/refund);
 *  - the bearer is the app-issued access token; referrals are deferred; identities are never linked automatically by email/phone.
 *
 * RATES MAPPING (PUT /shops/{shopId}/rates). The PDF stores one price per PAGE and printing type; the app stores one price per SHEET
 * for (paperSize, colourMode, sides). The owner-supplied per-page price P (paise) becomes, for paper size A4 (the only priced size):
 *   - single-sided rule = P        (one page per sheet)
 *   - duplex rule       = 2 * P    (two pages per sheet at the SAME per-page price: a duplex sheet is neither discounted nor inflated)
 * colored -> colourMode `colour`, blackWhite -> `bw`. No other price is invented; the server stays authoritative when an order is priced.
 * The response shows pricePerPagePaise = the single-sided rule. Only A4 rules are replaced (the app prices A4 only); rules of any other
 * size are left untouched. The A4 set is replaced atomically in one transaction (delete + create) and audited. An empty `rates` list is
 * refused so a shop is never left without a price by accident.
 *
 * KNOWN GAPS (documented, not faked):
 *  - the shop has no `email` or `showQr` column: PATCH refuses them (400), admin create ignores the optional shop `email`;
 *  - accepted/printing/ready/completed status changes are produced by the Print action and the device flow, so they are refused with
 *    409 INVALID_TRANSITION (print-job / Windows-agent rules are never bypassed); only pending -> rejected is performed here;
 *  - customerPhone is always null: the app never exposes a customer's phone to the shop.
 */

const err = (status: number, code: string, message: string, details?: unknown) => new AppError(status, code as never, message, details);
const invalidField = (field: string, message: string) => err(400, 'VALIDATION_ERROR', message, { field });

const SHOP_PARAM = z.object({ shopId: z.string().min(8).max(64) }).strict();
/** Tenant check on routes that carry more params (orderId): only shopId is read here. */
const SHOP_OF_PARAMS = z.object({ shopId: z.string().min(8).max(64) }).passthrough();
const ORDER_PARAM = z.object({ shopId: z.string().min(8).max(64), orderId: z.string().min(8).max(64) }).strict();
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const PINCODE = /^[1-9][0-9]{5}$/;

type PrintingType = 'colored' | 'blackWhite';
const COLOUR_MODE: Record<PrintingType, 'colour' | 'bw'> = { colored: 'colour', blackWhite: 'bw' };
const PRINTING_TYPES: PrintingType[] = ['colored', 'blackWhite'];
/** The app's per-sheet ceiling is 1,000,000 paise; the duplex sheet is 2 * per-page, so the per-page ceiling is half of it. */
const MAX_PAGE_PRICE = 500_000;

const ratesSchema = z
  .array(z.object({ printingType: z.enum(['colored', 'blackWhite']), pricePerPagePaise: z.number().int().min(1).max(MAX_PAGE_PRICE) }).strict())
  .min(1)
  .max(10);
const ratesBody = z.object({ rates: ratesSchema }).strict();
type RateInput = z.infer<typeof ratesSchema>;

/** Throws DUPLICATE_PRINTING_TYPE when a printing type is sent twice. */
function assertUniqueTypes(rates: RateInput): void {
  if (new Set(rates.map((r) => r.printingType)).size !== rates.length) {
    throw err(400, 'DUPLICATE_PRINTING_TYPE', 'Send each printing type once', { field: 'rates' });
  }
}

/** Replaces the shop's A4 rules from per-page rates (see RATES MAPPING). Must run inside the caller's transaction. */
async function replaceRates(tx: Prisma.TransactionClient, shopId: string, rates: RateInput): Promise<void> {
  await tx.pricingRule.deleteMany({ where: { shopId, paperSize: 'A4' } });
  await tx.pricingRule.createMany({
    data: rates.flatMap((r) => [
      { shopId, paperSize: 'A4', colourMode: COLOUR_MODE[r.printingType], sides: 'single' as const, pricePerSheetPaise: r.pricePerPagePaise, active: true },
      { shopId, paperSize: 'A4', colourMode: COLOUR_MODE[r.printingType], sides: 'duplex' as const, pricePerSheetPaise: r.pricePerPagePaise * 2, active: true }
    ])
  });
}

async function readRates(db: Prisma.TransactionClient, shopId: string) {
  const rules = await db.pricingRule.findMany({ where: { shopId, paperSize: 'A4', sides: 'single', active: true } });
  return PRINTING_TYPES.flatMap((t) => {
    const rule = rules.find((r) => r.colourMode === COLOUR_MODE[t]);
    return rule ? [{ printingType: t, pricePerPagePaise: rule.pricePerSheetPaise, currency: 'INR' }] : [];
  });
}

/** PDF order status vocabulary <-> app statuses. PRINTED is an in-progress printing step; EXPIRED is a system cancellation. */
const PDF_STATUS_OF: Record<OrderStatus, string> = {
  NEW: 'pending',
  ACCEPTED: 'accepted',
  PRINTING: 'printing',
  PRINTED: 'printing',
  READY: 'ready',
  COLLECTED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  EXPIRED: 'cancelled'
};
const APP_STATUSES_OF: Record<string, OrderStatus[]> = {
  pending: [OrderStatus.NEW],
  accepted: [OrderStatus.ACCEPTED],
  printing: [OrderStatus.PRINTING, OrderStatus.PRINTED],
  ready: [OrderStatus.READY],
  completed: [OrderStatus.COLLECTED],
  rejected: [OrderStatus.REJECTED],
  cancelled: [OrderStatus.CANCELLED, OrderStatus.EXPIRED]
};
/** PDF page 21 status flow (shop actions only). */
const PDF_NEXT: Record<string, string[]> = { pending: ['accepted', 'rejected'], accepted: ['printing'], printing: ['ready'], ready: ['completed'] };

const patchShopBody = z
  .object({
    shopName: z.string().trim().min(2).max(100).optional(),
    phoneNumber: z.string().trim().regex(PHONE, 'Use +91 format, e.g. +919999999999').optional(),
    email: z.string().trim().max(254).optional(),
    addressLine1: z.string().trim().min(5).max(300).optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    pincode: z.string().trim().regex(PINCODE, 'pincode must be 6 digits').optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
    isOpen: z.boolean().optional(),
    upiId: z.string().trim().regex(UPI_ID, 'Enter a valid UPI ID such as name@bank').nullable().optional(),
    acceptedPaymentMethods: z.array(z.enum(['cash', 'upi'])).min(1).max(2).optional(),
    showQr: z.boolean().optional()
  })
  .strict();

const createShopBody = z
  .object({
    ownerPhoneNumber: z.string().trim().regex(PHONE, 'Use +91 format, e.g. +919999999999'),
    ownerName: z.string().trim().min(1).max(100),
    shopName: z.string().trim().min(2).max(100),
    phoneNumber: z.string().trim().regex(PHONE, 'Use +91 format, e.g. +919999999999'),
    email: z.string().trim().max(254).optional(),
    addressLine1: z.string().trim().min(5).max(300),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    pincode: z.string().trim().regex(PINCODE, 'pincode must be 6 digits'),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    upiId: z.string().trim().regex(UPI_ID, 'Enter a valid UPI ID such as name@bank').optional(),
    acceptedPaymentMethods: z.array(z.enum(['cash', 'upi'])).min(1).max(2).optional(),
    rates: ratesSchema.optional(),
    paperSizes: z.array(z.string().trim().min(1).max(20)).max(10).optional(),
    paperTypes: z.array(z.string().trim().min(1).max(30)).max(10).optional()
  })
  .strict();

const slugBase = (name: string) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return base.length >= 2 ? base : 'shop';
};

/** Deterministic placeholder email of an unclaimed owner: it cannot receive mail (.invalid) and the account has no usable password. */
const unclaimedOwnerEmail = (phone: string) => `owner-${phone.replace(/\D/g, '')}@unclaimed.printoutbuddy.invalid`;

async function readStream(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > max) throw err(400, 'FILE_TOO_LARGE', 'Shop photos can be at most 2 MiB');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function pdfOwnerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, storage, events } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** Owner session + CSRF for cookie mutations. A non-owner role is 403 NOT_SHOP_OWNER. */
  const ownerGuard = async (request: FastifyRequest) => {
    const auth = await authenticate(ctx, request, { allowSuspended: request.method === 'GET' });
    if (auth.role !== 'SHOP_OWNER') throw err(403, 'NOT_SHOP_OWNER', 'Shop owner account required');
    if (request.method !== 'GET') assertCsrf(ctx, request, auth);
  };
  /** The single tenant check. A shop the caller does not own is the PDF's 403 NOT_SHOP_OWNER (the app-native routes keep their 404). */
  const owned = async (request: FastifyRequest) => {
    const { shopId } = SHOP_OF_PARAMS.parse(request.params);
    try {
      await requireOwnedShop(prisma, authOf(request).userId, shopId);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) throw err(403, 'NOT_SHOP_OWNER', 'You do not own this shop');
      throw error;
    }
    return shopId;
  };

  // ---------------------------------------------------------------------------------------------------------------- owner

  app.get('/shops/mine', { ...pdfTwin, preHandler: [ownerGuard, limits.shopRead] }, async (request) => {
    const q = pageQuery.parse(request.query);
    const mine = await listOwnedShops(prisma, authOf(request).userId);
    const rows = await prisma.shop.findMany({
      where: { id: { in: mine.map((s) => s.id) } },
      select: { id: true, displayName: true, isVerified: true, acceptsOrders: true, status: true, ratingAvg: true, ratingCount: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    const items = rows.slice((q.page - 1) * q.limit, q.page * q.limit).map((s) => ({
      id: s.id,
      shopName: s.displayName,
      isVerified: s.isVerified,
      isOpen: s.acceptsOrders,
      isActive: s.status === ShopStatus.ACTIVE,
      ratingAvg: s.ratingAvg,
      ratingCount: s.ratingCount
    }));
    return paginated(items, q.page, q.limit, rows.length);
  });

  app.patch('/shops/:shopId', { ...pdfTwin, preHandler: [ownerGuard] }, async (request) => {
    const shopId = await owned(request);
    const raw = (request.body ?? {}) as Record<string, unknown>;
    for (const key of ['isVerified', 'isActive', 'status']) {
      if (key in raw) throw invalidField(key, `${key} cannot be changed here (admin only)`);
    }
    const body = patchShopBody.parse(raw);
    if (body.email !== undefined) throw invalidField('email', 'Shop email is not supported yet');
    if (body.showQr !== undefined) throw invalidField('showQr', 'showQr is not supported yet');
    if (body.isOpen === true) {
      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { isVerified: true } });
      if (!shop.isVerified) throw err(422, 'SHOP_NOT_VERIFIED', 'A shop can open only after it is verified', { field: 'isOpen' });
    }
    const { email: _email, showQr: _showQr, ...nativeBody } = body;
    await forward(app, request, { method: 'PATCH', url: `/shops/${shopId}`, body: nativeBody });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    return {
      id: shop.id,
      shopName: shop.displayName,
      isOpen: shop.acceptsOrders,
      upiId: shop.upiId,
      acceptedPaymentMethods: shop.acceptedPaymentMethods.map((m) => apiPaymentMethod(m)),
      updatedAt: shop.updatedAt
    };
  });

  app.put('/shops/:shopId/rates', { ...pdfOnly, preHandler: [ownerGuard, limits.shopMutation] }, async (request) => {
    const shopId = await owned(request);
    const body = ratesBody.parse(request.body);
    assertUniqueTypes(body.rates);
    const rates = await prisma.$transaction(async (tx) => {
      await replaceRates(tx, shopId, body.rates);
      await audit(tx, {
        shopId,
        actorUserId: authOf(request).userId,
        actorType: 'SHOP_OWNER',
        action: 'shop.rates.replaced',
        targetType: 'shop',
        targetId: shopId,
        metadata: { rates: body.rates.map((r) => ({ printingType: r.printingType, pricePerPagePaise: r.pricePerPagePaise })) }
      });
      return readRates(tx, shopId);
    });
    return { shopId, rates };
  });

  app.put('/shops/:shopId/paper-options', { ...pdfTwin, preHandler: [ownerGuard] }, async (request) => {
    const shopId = await owned(request);
    const { data } = await forward(app, request, { method: 'PUT', url: `/shops/${shopId}/paper-options`, body: request.body });
    return data;
  });

  /** PDF form of POST /shops/{shopId}/images: JSON `{fileKey}` from /uploads/presign. The raw-bytes route is unchanged. */
  app.post('/shops/:shopId/images', { ...pdfTwin, preHandler: [ownerGuard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const shopId = await owned(request);
    const { fileKey } = z.object({ fileKey: z.string().min(1).max(256) }).strict().parse(request.body);
    // The key must be an upload of THIS caller that no order has consumed; anything else is indistinguishable from a missing file.
    const upload = await prisma.document.findFirst({ where: { objectKey: fileKey, uploaderUserId: auth.userId, deletedAt: null, order: { is: null } } });
    if (!upload) throw err(422, 'FILE_NOT_FOUND', 'Uploaded file not found');
    const head = await storage.head(fileKey).catch(() => null);
    if (!head) throw err(422, 'FILE_NOT_FOUND', 'Uploaded file not found');
    if (head.size > MAX_SHOP_IMAGE_BYTES) throw err(400, 'FILE_TOO_LARGE', 'Shop photos can be at most 2 MiB');
    const bytes = await readStream(await storage.openRead(fileKey), MAX_SHOP_IMAGE_BYTES);
    const kind = sniffImage(bytes);
    if (!kind) throw err(400, 'UNSUPPORTED_FILE_TYPE', 'Only JPEG and PNG images are accepted.');
    if ((await prisma.shopImage.count({ where: { shopId } })) >= MAX_SHOP_IMAGES) throw err(409, 'CONFLICT', `A shop can have at most ${MAX_SHOP_IMAGES} photos.`);
    // Copy to an opaque shop-image key: the original upload keeps its own lifecycle (retention/cleanup) untouched.
    const imageKey = generateObjectKey();
    await storage.put(imageKey, Readable.from(bytes), { maxBytes: MAX_SHOP_IMAGE_BYTES, contentType: kind.mime });
    try {
      const last = await prisma.shopImage.aggregate({ where: { shopId }, _max: { sortOrder: true } });
      const image = await prisma.shopImage.create({ data: { shopId, imageKey, contentType: kind.mime, sizeBytes: bytes.length, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
      await audit(prisma, { shopId, actorUserId: auth.userId, actorType: 'SHOP_OWNER', action: 'shop.image.added', targetType: 'shop', targetId: shopId, metadata: { imageId: image.id, bytes: bytes.length, via: 'fileKey' } });
      reply.code(201);
      return { id: image.id, url: customerImagePath(shopId, image.id), sortOrder: image.sortOrder };
    } catch (error) {
      await storage.delete(imageKey).catch(() => undefined);
      throw error;
    }
  });

  app.get('/shops/:shopId/orders', { ...pdfTwin, preHandler: [ownerGuard, limits.shopRead] }, async (request) => {
    const shopId = await owned(request);
    const q = pageQuery.extend({ status: z.enum(['pending', 'accepted', 'printing', 'ready', 'completed', 'rejected', 'cancelled']).optional() }).parse(request.query);
    const where: Prisma.OrderWhereInput = { shopId, ...(q.status ? { status: { in: APP_STATUSES_OF[q.status]! } } : {}) };
    const [rows, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { document: true, customer: { select: { displayName: true } } }
      }),
      prisma.order.count({ where })
    ]);
    const items = rows.map((o) => {
      const opts = (o.printOptionsSnapshot ?? {}) as { paperSize?: string; colourMode?: string; copies?: number };
      const price = (o.priceSnapshot ?? {}) as { selectedPageCount?: number };
      const pages = price.selectedPageCount ?? o.document.pageCount ?? 0;
      const copies = opts.copies ?? 1;
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.customer?.displayName ?? o.customerDisplayNameOrReference ?? null,
        // The app never shows a customer's phone to the shop, so the PDF field is present but null.
        customerPhone: null,
        fileName: o.document.originalFilename,
        pages,
        copies,
        totalPages: pages * copies,
        printingType: opts.colourMode === 'colour' ? 'colored' : 'blackWhite',
        paperSize: opts.paperSize ?? 'A4',
        paperType: 'normal',
        totalPaise: o.totalPaise,
        paymentMethod: apiPaymentMethod(o.paymentMethod),
        paymentStatus: apiPaymentStatus(o.paymentStatus),
        status: PDF_STATUS_OF[o.status],
        createdAt: o.createdAt
      };
    });
    return paginated(items, q.page, q.limit, total);
  });

  app.patch('/shops/:shopId/orders/:orderId/status', { ...pdfTwin, preHandler: [ownerGuard, limits.status] }, async (request) => {
    const auth = authOf(request);
    const { orderId } = ORDER_PARAM.parse(request.params);
    const shopId = await owned(request);
    const body = z
      .object({ status: z.enum(['accepted', 'rejected', 'printing', 'ready', 'completed']), rejectReason: z.string().trim().min(1).max(250).optional() })
      .strict()
      .parse(request.body);
    if (body.status === 'rejected' && !body.rejectReason) throw invalidField('rejectReason', 'rejectReason is required when rejecting');
    const order = await prisma.order.findFirst({ where: { id: orderId, shopId }, select: { status: true } });
    if (!order) throw orderNotFound();
    const current = PDF_STATUS_OF[order.status]!;
    if (!PDF_NEXT[current]?.includes(body.status)) throw err(409, 'INVALID_TRANSITION', `Cannot change an order from ${current} to ${body.status}`, { from: current, to: body.status });
    if (body.status !== 'rejected') {
      // accepted/printing are produced by the Print action (print job / Windows agent rules) and ready/completed by the device flow;
      // they are never faked from here.
      throw err(409, 'INVALID_TRANSITION', `${body.status} is set by the Print action, not directly`, { from: current, to: body.status });
    }
    const result = await shopChangeStatus(ctx, { shopId, orderId, actorUserId: auth.userId, toStatus: OrderStatus.REJECTED, reason: body.rejectReason });
    if (result.changed) {
      const payload = { id: result.order.id, orderNumber: result.order.orderNumber, status: result.order.status, updatedAt: result.order.updatedAt };
      events.emit(shopId, 'order.statusChanged', payload);
      events.emit(shopId, 'order.updated', payload);
    }
    return { id: result.order.id, status: PDF_STATUS_OF[result.order.status], acceptedAt: null, updatedAt: result.order.updatedAt };
  });

  app.patch('/shops/:shopId/orders/:orderId/payment', { ...pdfTwin, preHandler: [ownerGuard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const { orderId } = ORDER_PARAM.parse(request.params);
    const shopId = await owned(request);
    const body = z.object({ paymentStatus: z.enum(['paid', 'unpaid']) }).strict().parse(request.body);
    try {
      const result = await setPaymentByShop(prisma, { shopId, orderId, actor: { userId: auth.userId, role: 'SHOP_OWNER' }, to: body.paymentStatus === 'paid' ? 'PAID' : 'UNPAID' });
      if (!result) throw orderNotFound();
      pushCustomerNotification(ctx, result.notification);
      return { id: result.order.id, paymentStatus: apiPaymentStatus(result.order.paymentStatus) };
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_PAYMENT_TRANSITION') throw err(409, 'INVALID_STATUS', error.message, error.details);
      throw error;
    }
  });

  // ---------------------------------------------------------------------------------------------------------------- admin

  app.get('/admin/shops', { ...pdfTwin, preHandler: [adminGuard(ctx), limits.adminRead] }, async (request) => {
    const q = pageQuery.extend({ isVerified: z.enum(['true', 'false']).optional() }).parse(request.query);
    const where: Prisma.ShopWhereInput = q.isVerified ? { isVerified: q.isVerified === 'true' } : {};
    const [rows, total] = await Promise.all([
      prisma.shop.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, select: { id: true, displayName: true, city: true, isVerified: true, status: true } }),
      prisma.shop.count({ where })
    ]);
    return paginated(
      rows.map((s) => ({ id: s.id, shopName: s.displayName, city: s.city, isVerified: s.isVerified, isActive: s.status === ShopStatus.ACTIVE })),
      q.page,
      q.limit,
      total
    );
  });

  /** Native verify/block are the audited admin routes (admin guard, CSRF, rate limit, audit); the twins only translate the 404 code and trim the response. */
  const shopNotFound = (error: unknown): never => {
    if (error instanceof AppError && error.statusCode === 404) throw err(404, 'SHOP_NOT_FOUND', 'Shop not found');
    throw error;
  };

  app.patch('/admin/shops/:shopId/verify', { ...pdfTwin }, async (request) => {
    const { shopId } = SHOP_PARAM.parse(request.params);
    try {
      const { data } = await forward<{ id: string; isVerified: boolean; verifiedAt: string | null; verifiedBy: string | null }>(app, request, { method: 'PATCH', url: `/admin/shops/${shopId}/verify`, body: request.body });
      return { id: data.id, isVerified: data.isVerified, verifiedAt: data.verifiedAt, verifiedBy: data.verifiedBy };
    } catch (error) {
      return shopNotFound(error);
    }
  });

  app.patch('/admin/shops/:shopId/block', { ...pdfTwin }, async (request) => {
    const { shopId } = SHOP_PARAM.parse(request.params);
    try {
      const { data } = await forward<{ id: string; isActive: boolean }>(app, request, { method: 'PATCH', url: `/admin/shops/${shopId}/block`, body: request.body });
      return { id: data.id, isActive: data.isActive };
    } catch (error) {
      return shopNotFound(error);
    }
  });

  /**
   * PDF admin create. The native POST /admin/shops (email + password owner) is untouched. Here the owner is identified by phone but NEVER
   * linked to a login identity: an existing SHOP_OWNER that already holds this phone as a verified identity is reused; otherwise an
   * UNCLAIMED owner (placeholder email derived from the phone, random unusable password, passwordSet=false, no phone identity) is created
   * and reused by later creates for the same phone. The owner can sign in only after an explicit, authenticated identity link.
   * The shop starts unverified and closed (isActive true, isOpen false). No plan/subscription is created.
   */
  app.post('/admin/shops', { ...pdfTwin, preHandler: [adminGuard(ctx), limits.adminMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const body = createShopBody.parse(request.body);
    if (body.rates) assertUniqueTypes(body.rates);
    const methods = [...new Set((body.acceptedPaymentMethods ?? ['cash']).map(dbPaymentMethod))];
    if (methods.includes('UPI') && !body.upiId) throw invalidField('upiId', 'Set a UPI ID to accept UPI payments');
    const sizes = [...new Set(body.paperSizes ?? [])];
    const types = [...new Set(body.paperTypes ?? [])];
    if (sizes.length !== (body.paperSizes ?? []).length || types.length !== (body.paperTypes ?? []).length) throw invalidField('paperSizes', 'Duplicate paper option');
    const badType = types.find((t) => !(SUPPORTED_PAPER_TYPES as readonly string[]).includes(t));
    if (badType) throw err(400, 'UNSUPPORTED_PAPER', `Paper type "${badType}" is not supported yet`, { field: 'paperTypes' });
    if (sizes.length && !(body.rates && sizes.every((s) => s === 'A4'))) throw err(400, 'UNSUPPORTED_PAPER', 'Paper sizes can be advertised only with a price (A4 rates)', { field: 'paperSizes' });
    const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
    try {
      const created = await prisma.$transaction(async (tx) => {
        const dup = await tx.shop.findFirst({ where: { displayName: { equals: body.shopName, mode: 'insensitive' }, settings: { is: { publicContact: body.phoneNumber } } }, select: { id: true } });
        if (dup) throw err(409, 'SHOP_ALREADY_EXISTS', 'A shop with this name and phone number already exists');
        const identity = await tx.userPhoneIdentity.findUnique({ where: { phoneE164: body.ownerPhoneNumber }, include: { user: true } });
        let owner = identity?.user ?? (await tx.user.findUnique({ where: { email: unclaimedOwnerEmail(body.ownerPhoneNumber) } }));
        if (owner && owner.role !== Role.SHOP_OWNER) throw err(409, 'CONFLICT', 'This phone number belongs to a non-owner account', { field: 'ownerPhoneNumber' });
        const ownerReused = Boolean(owner);
        owner ??= await tx.user.create({
          data: { email: unclaimedOwnerEmail(body.ownerPhoneNumber), displayName: body.ownerName, passwordHash, passwordSet: false, role: Role.SHOP_OWNER }
        });
        const shop = await tx.shop.create({
          data: {
            slug: `${slugBase(body.shopName)}-${randomBytes(3).toString('hex')}`,
            displayName: body.shopName,
            address: body.addressLine1,
            city: body.city,
            state: body.state,
            pincode: body.pincode,
            latitude: body.latitude,
            longitude: body.longitude,
            upiId: body.upiId ?? null,
            acceptedPaymentMethods: methods,
            acceptsOrders: false,
            settings: { create: { publicContact: body.phoneNumber } }
          }
        });
        await tx.membership.create({ data: { shopId: shop.id, userId: owner.id, role: 'OWNER' } });
        if (!owner.shopId) await tx.user.update({ where: { id: owner.id }, data: { shopId: shop.id } });
        await tx.userRoleGrant.upsert({ where: { userId_role: { userId: owner.id, role: Role.SHOP_OWNER } }, create: { userId: owner.id, role: Role.SHOP_OWNER }, update: {} });
        if (body.rates) await replaceRates(tx, shop.id, body.rates);
        if (sizes.length || types.length) {
          await tx.shopPaperOption.createMany({ data: [...sizes.map((value) => ({ shopId: shop.id, kind: 'paperSize', value })), ...types.map((value) => ({ shopId: shop.id, kind: 'paperType', value }))] });
        }
        await audit(tx, {
          shopId: shop.id,
          actorUserId: auth.userId,
          actorType: 'PLATFORM_ADMIN',
          action: 'admin.shop.create',
          targetType: 'shop',
          targetId: shop.id,
          metadata: { ownerUserId: owner.id, ownerReused, via: 'pdf', rates: body.rates?.length ?? 0 }
        });
        return { shop, owner };
      });
      reply.code(201);
      return { id: created.shop.id, ownerId: created.owner.id, shopName: created.shop.displayName, isVerified: created.shop.isVerified, isActive: created.shop.status === ShopStatus.ACTIVE, isOpen: created.shop.acceptsOrders };
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw err(409, 'CONFLICT', 'Owner already exists; retry', { field: 'ownerPhoneNumber' });
      throw error;
    }
  });
}
