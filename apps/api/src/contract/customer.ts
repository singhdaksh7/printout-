import { createHash, randomUUID } from 'node:crypto';
import { DocumentStatus, type OrderStatus, type Prisma, type Role } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { documentAccessWindow } from '../domain/access.js';
import { shopCards, type RateView } from '../domain/discovery.js';
import { subscriptionAllowsIntake } from '../domain/eligibility.js';
import { DEFAULT_RADIUS_KM, MAX_RADIUS_KM, selectGeoRepository } from '../domain/geo.js';
import { assertAcceptingByHours } from '../domain/hours-view.js';
import { createOrderFromQuote } from '../domain/order-create.js';
import { apiPaymentMethod, apiPaymentStatus, dbPaymentMethod, UPI_REF } from '../domain/payments.js';
import { issueDocumentAccess } from '../domain/print-service.js';
import { loadProfile } from '../domain/profile.js';
import { qrReadiness } from '../domain/onboarding.js';
import { listOwnedShops } from '../domain/shop-access.js';
import { AppError, orderNotFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { assertCsrf, audit, authenticate, authOf, customerGuard, isUniqueViolation, type AppContext } from '../routes/context.js';
import { MAX_CUSTOMER_COPIES } from '../routes/customer-orders.js';
import { publicName } from '../routes/customer-reviews.js';
import { PINCODE } from '../routes/profile.js';
import { sanitizeFilename } from '../storage/filename.js';
import { ACCEPTED_MIME_TYPES } from '../uploads.js';
import { forward, pageQuery, paginated, pdfOnly, pdfTwin } from './facade.js';

/**
 * PDF contract routes for everyone/customers (printout_buddy_schema.pdf pages 7-14): /me, /me/fcm-token, /shops/nearby, shop detail
 * and reviews, /uploads/presign, /orders*, /reviews. Responses are BARE JSON (no `{ data }` envelope) and errors use the PDF shape
 * (see facade.ts). Every route delegates to the existing guards, limiters, pricing engine, order-creation transaction, payment and
 * review domain code, so ownership checks, server-authoritative pricing, idempotency and audit are not bypassed.
 *
 * APPROVED DIFFERENCES FROM THE PDF (owner decisions, do not "fix" here):
 *  - Upload size stays 50 MiB (config UPLOAD_MAX_BYTES), not 20 MB. Document retention stays the configured short window, not 7 days / 24 h.
 *  - Pricing is server-authoritative PER SHEET with duplex handling. The PDF's `pricePerPagePaise` is an adapter value: orders created
 *    here are single-sided, where one page is one sheet, so it equals the shop's per-sheet rate exactly and
 *    `totalPaise === pricePerPagePaise * totalPages`. For orders placed through the app flow (possibly duplex) it is `totalPaise /
 *    totalPages` only when that division is exact, otherwise null. `totalPaise` is always the server's own quote, never recomputed.
 *  - The bearer is the app-issued access token (Firebase token only at POST /auth/login). Referrals are deferred (referralCode is null).
 *    No automatic identity linking.
 *
 * Other documented adapter behaviour:
 *  - POST /uploads/presign needs the target shop because documents are stored per shop: `shopId` is an EXTRA required body field.
 *    `fileKey` is `uploads/{userId}/{uploadId}-{fileName}`; the order step re-checks the prefix and ownership.
 *  - POST /orders completes (validates, counts pages of) the uploaded file itself; client `pages` is accepted but the server count wins.
 *    Orders are single-sided A4 on normal paper (the only priced combination); other paper sizes/types answer UNSUPPORTED_PAPER.
 *  - Status vocabulary: NEW=pending, ACCEPTED=accepted, PRINTING and PRINTED=printing, READY=ready, COLLECTED=completed,
 *    REJECTED=rejected, CANCELLED and EXPIRED=cancelled.
 *  - Reviews follow the existing rule (allowed once printing has started), a superset of the PDF's "completed".
 *  - Not-yours order ids answer 403 NOT_ORDER_OWNER as the PDF says (ids are unguessable); unknown ids answer 404 ORDER_NOT_FOUND.
 *  - Shop images are authenticated API URLs (never storage URLs); showQr is false and qrCodeUrl null (no payment QR is modelled).
 *  - FCM tokens: PUT/DELETE answer 204 and never echo the token. The installation id is derived from the token hash.
 *  - A paid or payment-pending order cannot be cancelled by the customer (existing PAYMENT_RECORDED, 409) in addition to the PDF rules.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    pdf?: boolean;
  }
}

const pdfErr = (status: number, code: string, message: string, details?: unknown) => new AppError(status, code as never, message, details);

/** Re-states an internal error with the PDF's status/code where the two differ. */
const REMAP: Record<string, { status?: number; code?: string }> = {
  SHOP_CLOSED: { status: 422 },
  SHOP_UNAVAILABLE: { status: 422, code: 'SHOP_CLOSED' },
  FILE_TOO_LARGE: { status: 400 },
  INVALID_FILE_TYPE: { status: 400, code: 'UNSUPPORTED_FILE_TYPE' },
  NO_PRICING_RULE: { status: 422, code: 'RATE_NOT_SET' },
  DOCUMENT_UNAVAILABLE: { status: 422, code: 'FILE_NOT_FOUND' }
};
async function remapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) {
      const r = REMAP[error.code];
      if (r) throw new AppError(r.status ?? error.statusCode, (r.code ?? error.code) as never, error.message, error.details);
    }
    throw error;
  }
}

// ---- vocabulary ------------------------------------------------------------------------------------------------------------------

export const PDF_STATUSES = ['pending', 'accepted', 'printing', 'ready', 'completed', 'rejected', 'cancelled'] as const;
type PdfStatus = (typeof PDF_STATUSES)[number];
const STATUS_OUT: Record<OrderStatus, PdfStatus> = {
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
export const pdfOrderStatus = (s: OrderStatus): PdfStatus => STATUS_OUT[s];
const STATUS_IN: Record<PdfStatus, OrderStatus[]> = {
  pending: ['NEW'],
  accepted: ['ACCEPTED'],
  printing: ['PRINTING', 'PRINTED'],
  ready: ['READY'],
  completed: ['COLLECTED'],
  rejected: ['REJECTED'],
  cancelled: ['CANCELLED', 'EXPIRED']
};

const PDF_TYPE = { colour: 'colored', bw: 'blackWhite' } as const;
const INTERNAL_TYPE = { colored: 'colour', blackWhite: 'bw' } as const;
const ROLE_OUT: Record<Role, string> = { CUSTOMER: 'customer', SHOP_OWNER: 'shopOwner', PLATFORM_ADMIN: 'admin' };

/** Only single-sided A4 rules map onto the PDF's single "price per page": for them one page is one sheet, so the value is exact. */
export const pdfRates = (rates: RateView[]) =>
  rates.filter((r) => r.paperSize === 'A4' && r.sides === 'single').map((r) => ({ printingType: PDF_TYPE[r.colourMode], pricePerPagePaise: r.pricePerSheetPaise }));

/** PDF price fields derived from the order's own snapshot; totalPaise is the server's stored quote. */
export function pdfPricing(o: { totalPaise: number; priceSnapshot: Prisma.JsonValue; printOptionsSnapshot: Prisma.JsonValue; document: { pageCount: number | null } }) {
  const snap = (o.priceSnapshot ?? {}) as { selectedPageCount?: number; unitPricePaise?: number };
  const opts = (o.printOptionsSnapshot ?? {}) as { colourMode?: 'bw' | 'colour'; sides?: 'single' | 'duplex'; copies?: number; paperSize?: string };
  const pages = snap.selectedPageCount ?? o.document.pageCount ?? 0;
  const copies = opts.copies ?? 1;
  const totalPages = pages * copies;
  let pricePerPagePaise: number | null = null;
  if (opts.sides === 'single' && typeof snap.unitPricePaise === 'number') pricePerPagePaise = snap.unitPricePaise;
  else if (totalPages > 0 && o.totalPaise % totalPages === 0) pricePerPagePaise = o.totalPaise / totalPages;
  return {
    printingType: opts.colourMode ? PDF_TYPE[opts.colourMode] : null,
    paperSize: opts.paperSize ?? 'A4',
    paperType: 'normal',
    pages,
    copies,
    totalPages,
    pricePerPagePaise,
    totalPaise: o.totalPaise
  };
}

type OrderRow = Prisma.OrderGetPayload<{ include: { shop: { select: { displayName: true } }; document: true } }>;
const orderInclude = { shop: { select: { displayName: true } }, document: true } as const;

const orderView = (o: OrderRow) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  shopId: o.shopId,
  shopName: o.shop.displayName,
  status: pdfOrderStatus(o.status),
  paymentMethod: apiPaymentMethod(o.paymentMethod),
  paymentStatus: apiPaymentStatus(o.paymentStatus),
  fileName: o.document.originalFilename,
  ...pdfPricing(o),
  note: o.note,
  createdAt: o.createdAt
});

// ---- request schemas -------------------------------------------------------------------------------------------------------------

const idSchema = z.string().min(8).max(64);
const coordinate = (min: number, max: number) => z.number().finite().min(min).max(max);
const patchMeBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z
      .string()
      .trim()
      .max(254)
      .email()
      .transform((v) => v.toLowerCase())
      .optional(),
    addressLine1: z.string().trim().min(2).max(200).optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    pincode: z.string().trim().regex(PINCODE, 'pincode must be 6 digits').optional(),
    latitude: coordinate(-90, 90).optional(),
    longitude: coordinate(-180, 180).optional()
  })
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), { message: 'latitude and longitude must be sent together', path: ['latitude'] })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to update.' });
const fcmTokenSchema = z.string().min(20).max(4096).regex(/^\S+$/);
const fcmPutBody = z.object({ token: fcmTokenSchema, platform: z.enum(['android', 'ios', 'web']) });
const fcmDeleteQuery = z.object({ token: fcmTokenSchema });
const nearbyQuery = pageQuery.extend({
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  radiusKm: z.coerce.number().finite().positive().max(MAX_RADIUS_KM).default(DEFAULT_RADIUS_KM),
  printingType: z.enum(['colored', 'blackWhite']).optional()
});
const shopParam = z.object({ shopId: idSchema });
const presignBody = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  sizeBytes: z.number().int().min(0),
  /** Extra (not in the PDF): documents are stored per shop. */
  shopId: idSchema.optional()
});
const orderBody = z.object({
  shopId: idSchema,
  fileKey: z.string().min(1).max(600),
  fileName: z.string().min(1).max(255).optional(),
  fileContentType: z.string().max(100).optional(),
  fileSizeBytes: z.number().int().min(0).optional(),
  pages: z.number().int().min(1).optional(),
  printingType: z.enum(['colored', 'blackWhite']),
  paperSize: z.string().min(1).max(20),
  paperType: z.string().min(1).max(20),
  copies: z.number().int().min(1).max(MAX_CUSTOMER_COPIES).default(1),
  note: z.string().trim().max(500).optional(),
  paymentMethod: z.enum(['cash', 'upi'])
});
const orderListQuery = pageQuery.extend({ status: z.enum(PDF_STATUSES).optional() });
const cancelBody = z.object({ cancelReason: z.string().trim().max(200).optional() });
const paymentBody = z.object({ upiTxnRef: z.string().trim().regex(UPI_REF, 'upiTxnRef must be 8-22 letters or digits') });
const reviewBody = z.object({ orderId: idSchema, rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() });

/** `uploads/{userId}/{uploadId}-{fileName}`; uploadId is 18 random bytes in base64url = 24 characters. */
const FILE_KEY = /^uploads\/([^/]+)\/([A-Za-z0-9_-]{24})-.+$/;

/** Maps any Idempotency-Key string to the UUID the order layer keys on, namespaced by the caller so keys never collide across customers. */
function clientRequestIdFor(request: FastifyRequest, userId: string): string {
  const header = request.headers['idempotency-key'];
  if (header === undefined) return randomUUID();
  const key = typeof header === 'string' ? header.trim() : '';
  if (key.length < 1 || key.length > 255) throw pdfErr(400, 'VALIDATION_ERROR', 'Idempotency-Key must be 1-255 characters', { field: 'Idempotency-Key' });
  const h = createHash('sha256').update(`pdf-idem:${userId}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function pdfCustomerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, storage } = ctx;
  const limits = getLimiters(app, config);
  const guard = customerGuard(ctx);
  const geo = selectGeoRepository(prisma, config.GEO_BACKEND, () => app.log.warn('GEO_BACKEND=postgis but the extension is not installed; using the haversine fallback'));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** Any signed-in account (customer, owner or admin); CSRF is enforced for cookie-authenticated mutations (bearer is exempt). */
  const anyGuard = async (request: FastifyRequest): Promise<void> => {
    const auth = await authenticate(ctx, request);
    if (request.method !== 'GET') assertCsrf(ctx, request, auth);
  };

  // ---- /me -------------------------------------------------------------------------------------------------------------------------

  app.get('/me', { ...pdfOnly }, async (request, reply) => {
    const auth = await authenticate(ctx, request, { allowSuspended: true });
    await limits.shopRead(request, reply);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { roleGrants: { select: { role: true } } } });
    const profile = (await loadProfile(prisma, config.WEB_ORIGIN, auth.userId)).user;
    const roles = [...new Set([user.role, ...user.roleGrants.map((g) => g.role)])].map((r) => ROLE_OUT[r]);
    return {
      id: user.id,
      roles,
      name: profile.name,
      email: profile.email,
      phoneNumber: profile.phoneNumber,
      emailVerified: profile.emailVerified,
      phoneVerified: profile.phoneVerified,
      loginMethods: profile.loginMethods,
      referralCode: null,
      addressLine1: user.addressLine1,
      addressLine2: user.addressLine2,
      city: user.city,
      state: user.state,
      country: null,
      pincode: user.pincode,
      latitude: user.latitude,
      longitude: user.longitude
    };
  });

  app.patch('/me', { ...pdfOnly, preHandler: [anyGuard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const body = patchMeBody.parse(request.body);
    const current = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, email: true, role: true } });
    const { name, email, ...rest } = body;
    if (current.role === 'CUSTOMER') {
      const data: Prisma.UserUpdateInput = { ...rest, ...(name !== undefined ? { displayName: name } : {}) };
      if (email !== undefined && email !== current.email?.toLowerCase()) data.email = email;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({ where: { id: auth.userId }, data });
          await audit(tx, { shopId: null, actorUserId: auth.userId, actorType: 'CUSTOMER', action: 'customer.profile.updated', targetType: 'user', targetId: auth.userId, metadata: { fields: Object.keys(body) } });
        });
      } catch (error) {
        if (isUniqueViolation(error, 'email')) throw pdfErr(409, 'EMAIL_TAKEN', 'This email address is already used by another account');
        throw error;
      }
    } else {
      // Owners and admins keep the existing rules (an email change needs their password and is refused here).
      if (Object.values(rest).some((v) => v !== undefined)) throw pdfErr(400, 'VALIDATION_ERROR', 'Address and location are only stored for customer accounts', { field: 'addressLine1' });
      await forward(app, request, { method: 'PATCH', url: '/users/me', body: { ...(name !== undefined ? { name } : {}), ...(email !== undefined ? { email } : {}) } });
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, displayName: true, email: true, pincode: true } });
    return { id: row.id, name: row.displayName, email: row.email, pincode: row.pincode };
  });

  // ---- FCM token (reuses the encrypted, user-scoped registration store; the token is never returned or logged) ------------------------

  app.put('/me/fcm-token', { ...pdfOnly, preHandler: [anyGuard] }, async (request, reply) => {
    const body = fcmPutBody.parse(request.body);
    const installationId = `pdf${createHash('sha256').update(body.token).digest('hex').slice(0, 40)}`;
    await forward(app, request, { method: 'PUT', url: '/users/me/fcm-token', body: { installationId, token: body.token, platform: body.platform } });
    return reply.code(204).send();
  });

  app.delete('/me/fcm-token', { ...pdfOnly, preHandler: [anyGuard] }, async (request, reply) => {
    const q = fcmDeleteQuery.parse(request.query);
    await forward(app, request, { method: 'DELETE', url: '/users/me/fcm-token', body: { token: q.token } });
    return reply.code(204).send();
  });

  // ---- shops -----------------------------------------------------------------------------------------------------------------------

  app.get('/shops/nearby', { ...pdfOnly, preHandler: [anyGuard, limits.shopRead] }, async (request) => {
    const q = nearbyQuery.parse(request.query);
    const { rows, total } = await geo.nearby({
      lat: q.lat,
      lng: q.lng,
      radiusKm: q.radiusKm,
      ...(q.printingType ? { colourMode: INTERNAL_TYPE[q.printingType] } : {}),
      limit: q.limit,
      offset: (q.page - 1) * q.limit
    });
    const cards = await shopCards(prisma, rows.map((r) => r.id));
    const items = rows.flatMap((r) => {
      const c = cards.get(r.id);
      return c ? [{ id: c.id, shopName: c.shopName, city: c.city, distanceKm: r.distanceKm, ratingAvg: c.ratingAvg, ratingCount: c.ratingCount, isOpen: c.isOpen, rates: pdfRates(c.rates) }] : [];
    });
    return paginated(items, q.page, q.limit, total);
  });

  /** Customers see only verified, active shops. A shop's own owner also sees it while it is still pending (PILOT) or unverified. */
  async function visibleShop(shopId: string, viewerUserId?: string): Promise<string> {
    const shop = await prisma.shop.findFirst({ where: { id: shopId, isVerified: true, status: 'ACTIVE' }, select: { id: true } });
    if (shop) return shop.id;
    if (viewerUserId && (await listOwnedShops(prisma, viewerUserId)).some((s) => s.id === shopId)) return shopId;
    throw pdfErr(404, 'SHOP_NOT_FOUND', 'Shop not found');
  }

  // Twin of the owner's GET /shops/:shopId: only requests with `X-API-Contract: pdf` reach this handler.
  app.get('/shops/:shopId', { ...pdfTwin, preHandler: [anyGuard, limits.shopRead] }, async (request) => {
    const { shopId } = shopParam.parse(request.params);
    const viewer = authOf(request);
    const id = await visibleShop(shopId, viewer.userId);
    const c = (await shopCards(prisma, [id], { includeLocation: true })).get(id);
    if (!c) throw pdfErr(404, 'SHOP_NOT_FOUND', 'Shop not found');
    const base = (config.PUBLIC_API_BASE ?? '').replace(/\/$/, '');
    // The shop's public page is the QR's destination; only its owner is shown it, and only once the shop is live.
    const owned = viewer.role === 'SHOP_OWNER' && viewer.shopId !== null && (await listOwnedShops(prisma, viewer.userId)).some((s) => s.id === id);
    const qr = owned ? qrReadiness(await prisma.shop.findUniqueOrThrow({ where: { id }, select: { slug: true, status: true } }), config.WEB_ORIGIN) : null;
    return {
      id: c.id,
      shopName: c.shopName,
      phoneNumber: c.phoneNumber,
      addressLine1: c.addressLine1,
      addressLine2: c.addressLine2,
      city: c.city,
      state: c.state,
      pincode: c.pincode,
      location: c.location ?? null,
      isOpen: c.isOpen,
      ratingAvg: c.ratingAvg,
      ratingCount: c.ratingCount,
      upiId: c.upiId,
      acceptedPaymentMethods: c.acceptedPaymentMethods,
      showQr: qr?.ready ?? false,
      qrCodeUrl: qr?.publicUrl ?? null,
      rates: pdfRates(c.rates),
      paperSizes: c.paperSizes,
      paperTypes: c.paperTypes,
      images: c.images.map((i) => `${base}/api/v1${i.url}`)
    };
  });

  // Twin of the owner's GET /shops/:shopId/reviews (customer-visible shops only; plain rows, no aggregates).
  app.get('/shops/:shopId/reviews', { ...pdfTwin, preHandler: [anyGuard, limits.shopRead] }, async (request) => {
    const { shopId } = shopParam.parse(request.params);
    const id = await visibleShop(shopId, authOf(request).userId);
    const q = pageQuery.parse(request.query);
    const where = { shopId: id };
    const [rows, total] = await Promise.all([
      prisma.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, include: { customer: { select: { displayName: true } } } }),
      prisma.review.count({ where })
    ]);
    return paginated(
      rows.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, customerName: publicName(r.customer.displayName), createdAt: r.createdAt })),
      q.page,
      q.limit,
      total
    );
  });

  // ---- uploads ---------------------------------------------------------------------------------------------------------------------

  app.post('/uploads/presign', { ...pdfOnly, preHandler: [guard] }, async (request) => {
    const auth = authOf(request);
    const body = presignBody.parse(request.body);
    if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(body.contentType)) throw pdfErr(400, 'UNSUPPORTED_FILE_TYPE', 'Only PDF, JPEG and PNG files can be printed', { field: 'contentType' });
    if (!body.shopId) throw pdfErr(400, 'VALIDATION_ERROR', 'shopId is required (the shop the file is for)', { field: 'shopId' });
    const res = await remapped(() =>
      forward<{ uploadId: string; uploadUrl: string; requiredHeaders: Record<string, string>; expiresAt: string }>(app, request, {
        method: 'POST',
        url: '/customer/uploads',
        body: { shopId: body.shopId, fileName: body.fileName, byteSize: body.sizeBytes, declaredMimeType: body.contentType }
      })
    );
    const d = res.data;
    return { uploadUrl: d.uploadUrl, fileKey: `uploads/${auth.userId}/${d.uploadId}-${sanitizeFilename(body.fileName)}`, expiresAt: d.expiresAt, requiredHeaders: d.requiredHeaders };
  });

  // ---- orders ----------------------------------------------------------------------------------------------------------------------

  app.post('/orders', { ...pdfOnly, preHandler: [guard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const body = orderBody.parse(request.body); // any client amount is not part of the schema and is never read
    const clientRequestId = clientRequestIdFor(request, auth.userId);

    const shop = await prisma.shop.findFirst({
      where: { id: body.shopId, isVerified: true, status: 'ACTIVE' },
      include: { settings: true, subscription: { select: { status: true } }, paperOptions: true, pricingRules: { where: { active: true } } }
    });
    if (!shop) throw pdfErr(404, 'SHOP_NOT_FOUND', 'Shop not found');

    // Idempotent replay of this caller's own key: return the original order before re-evaluating anything that may have changed since.
    const prior = await prisma.order.findUnique({ where: { shopId_clientRequestId: { shopId: shop.id, clientRequestId } }, include: orderInclude });
    if (prior && prior.customerUserId === auth.userId) return reply.code(201).send(orderView(prior));

    // PDF check order (first failure stops): shop open, rate, paper, payment, file, then pages/copies.
    if (!shop.acceptsOrders || !subscriptionAllowsIntake(shop.subscription)) throw pdfErr(422, 'SHOP_CLOSED', 'This shop is not accepting orders right now');
    await remapped(async () => assertAcceptingByHours(shop.settings));

    const colourMode = INTERNAL_TYPE[body.printingType];
    if (!shop.pricingRules.some((r) => r.colourMode === colourMode && r.sides === 'single' && r.paperSize === 'A4')) throw pdfErr(422, 'RATE_NOT_SET', 'This shop has no rate for that printing type');

    const sizes = shop.paperOptions.filter((o) => o.kind === 'paperSize').map((o) => o.value);
    const types = shop.paperOptions.filter((o) => o.kind === 'paperType').map((o) => o.value);
    if (!(sizes.length ? sizes : ['A4']).includes(body.paperSize) || !(types.length ? types : ['normal']).includes(body.paperType)) {
      throw pdfErr(400, 'UNSUPPORTED_PAPER', 'This shop does not offer that paper size or type', { field: 'paperSize' });
    }
    // Approved difference: A4 on normal paper is the only combination with a price today.
    if (body.paperSize !== 'A4' || body.paperType !== 'normal') throw pdfErr(400, 'UNSUPPORTED_PAPER', 'Only A4 normal paper can be priced right now', { field: 'paperSize' });

    const method = dbPaymentMethod(body.paymentMethod);
    if (!shop.acceptedPaymentMethods.includes(method) || (method === 'UPI' && !shop.upiId)) {
      throw pdfErr(400, 'PAYMENT_METHOD_NOT_ACCEPTED', 'This shop does not accept that payment method', { field: 'paymentMethod' });
    }

    const key = FILE_KEY.exec(body.fileKey);
    if (!key) throw pdfErr(422, 'FILE_NOT_FOUND', 'File not found', { field: 'fileKey' });
    if (key[1] !== auth.userId) throw pdfErr(403, 'FORBIDDEN', 'That file does not belong to you', { field: 'fileKey' });
    const found = await prisma.document.findFirst({ where: { id: key[2]!, uploaderUserId: auth.userId, shopId: shop.id } });
    if (!found || (found.status !== DocumentStatus.UPLOADING && found.status !== DocumentStatus.AVAILABLE)) throw pdfErr(422, 'FILE_NOT_FOUND', 'File not found', { field: 'fileKey' });
    if (found.status === DocumentStatus.UPLOADING) {
      // The PDF has no separate "complete" step: validate the uploaded object and count its pages now (the server count wins over `pages`).
      try {
        await remapped(() => forward(app, request, { method: 'POST', url: `/public/shops/${shop.slug}/uploads/${found.id}/complete` }));
      } catch (error) {
        if (error instanceof AppError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) throw pdfErr(422, 'FILE_NOT_FOUND', 'The file was not uploaded', { field: 'fileKey' });
        throw error;
      }
    }

    const order = await remapped(() =>
      createOrderFromQuote(ctx, {
        shop,
        payload: { documentId: found.id, shopId: shop.id, printOptions: { paperSize: 'A4', colourMode, sides: 'single', copies: body.copies, pageSelection: { mode: 'all' } } },
        clientRequestId,
        customerUserId: auth.userId,
        note: body.note ?? null,
        paymentMethod: method
      })
    );
    const full = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    return reply.code(201).send(orderView(full));
  });

  app.get('/orders', { ...pdfOnly, preHandler: [guard, limits.shopRead] }, async (request) => {
    const auth = authOf(request);
    const q = orderListQuery.parse(request.query);
    const where: Prisma.OrderWhereInput = { customerUserId: auth.userId, ...(q.status ? { status: { in: STATUS_IN[q.status] } } : {}) };
    const [rows, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, include: orderInclude }),
      prisma.order.count({ where })
    ]);
    return paginated(
      rows.map((o) => ({ id: o.id, orderNumber: o.orderNumber, shopName: o.shop.displayName, status: pdfOrderStatus(o.status), paymentStatus: apiPaymentStatus(o.paymentStatus), totalPaise: o.totalPaise, createdAt: o.createdAt })),
      q.page,
      q.limit,
      total
    );
  });

  /** 404 ORDER_NOT_FOUND for an unknown id; 403 NOT_ORDER_OWNER when it is someone else's. `viewer: 'any'` also admits the shop's owner. */
  async function accessibleOrder(request: FastifyRequest, rawId: string, viewer: 'customer' | 'any') {
    const auth = authOf(request);
    const id = idSchema.safeParse(rawId);
    if (!id.success) throw orderNotFound();
    const order = await prisma.order.findUnique({ where: { id: id.data }, select: { id: true, shopId: true, customerUserId: true } });
    if (!order) throw orderNotFound();
    if (order.customerUserId === auth.userId) return { order, asOwner: false };
    if (viewer === 'any' && auth.role === 'SHOP_OWNER' && (await listOwnedShops(prisma, auth.userId)).some((s) => s.id === order.shopId)) return { order, asOwner: true };
    throw pdfErr(403, 'NOT_ORDER_OWNER', 'You do not have access to this order');
  }

  app.get('/orders/:orderId', { ...pdfOnly, preHandler: [anyGuard, limits.shopRead] }, async (request) => {
    const auth = authOf(request);
    const { orderId } = request.params as { orderId: string };
    const { order, asOwner } = await accessibleOrder(request, orderId, 'any');
    const full = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { ...orderInclude, histories: { orderBy: { createdAt: 'asc' } } } });
    return {
      ...orderView(full),
      statusHistory: full.histories.map((h) => ({
        status: pdfOrderStatus(h.toStatus),
        // The caller's own id (or any id for the shop's owner); for the customer other parties are a role label, never a user id.
        changedBy: asOwner || h.actorUserId === auth.userId ? h.actorUserId : h.actorUserId || h.actorDeviceId ? 'shop' : 'system',
        createdAt: h.createdAt
      }))
    };
  });

  app.get('/orders/:orderId/file', { ...pdfOnly, preHandler: [anyGuard, limits.documentAccess] }, async (request) => {
    const auth = authOf(request);
    const { orderId } = request.params as { orderId: string };
    const { order, asOwner } = await accessibleOrder(request, orderId, 'any');
    if (asOwner) {
      const a = await issueDocumentAccess(ctx, { actor: { type: 'SHOP_OWNER', userId: auth.userId }, shopId: order.shopId, orderId: order.id, disposition: 'attachment', requirePrintInitiated: false });
      return { downloadUrl: a.url, fileName: a.fileName, expiresAt: a.expiresAt };
    }
    const full = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { document: true } });
    const doc = full.document;
    const window = documentAccessWindow(doc, full.status, Date.now());
    // DOCUMENT_UNAVAILABLE is rendered as the PDF's 410 FILE_DELETED (facade CODE_MAP).
    if (!window || !doc.detectedMimeType) throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'The file is no longer available');
    const fileName = sanitizeFilename(doc.originalFilename);
    const access = await storage.temporaryReadUrl(doc.objectKey, window.ttlSeconds, { contentType: doc.detectedMimeType, filename: fileName, disposition: 'attachment' });
    await audit(prisma, { shopId: full.shopId, actorUserId: auth.userId, actorType: 'CUSTOMER', action: 'document.download', targetType: 'order', targetId: full.id });
    return { downloadUrl: access.url, fileName, expiresAt: new Date(Math.min(access.expiresAt.getTime(), window.deadline.getTime())) };
  });

  app.post('/orders/:orderId/cancel', { ...pdfOnly, preHandler: [guard] }, async (request) => {
    const { orderId } = request.params as { orderId: string };
    const body = cancelBody.parse(request.body ?? {});
    const { order } = await accessibleOrder(request, orderId, 'customer');
    const res = await forward<{ id: string; status: OrderStatus; cancelReason: string | null }>(app, request, {
      method: 'POST',
      url: `/customer/orders/${order.id}/cancel`,
      body: body.cancelReason ? { cancelReason: body.cancelReason } : {}
    });
    return { id: res.data.id, status: pdfOrderStatus(res.data.status), cancelReason: res.data.cancelReason };
  });

  app.post('/orders/:orderId/payment', { ...pdfOnly, preHandler: [guard] }, async (request) => {
    const { orderId } = request.params as { orderId: string };
    const body = paymentBody.parse(request.body);
    const { order } = await accessibleOrder(request, orderId, 'customer');
    const res = await forward<{ id: string; payment: { method: string | null; status: string; upiTxnRef: string | null } }>(app, request, {
      method: 'POST',
      url: `/customer/orders/${order.id}/payment`,
      body: { upiTxnRef: body.upiTxnRef }
    });
    return { id: res.data.id, paymentMethod: res.data.payment.method, paymentStatus: res.data.payment.status, upiTxnRef: res.data.payment.upiTxnRef };
  });

  // ---- reviews ---------------------------------------------------------------------------------------------------------------------

  app.post('/reviews', { ...pdfOnly, preHandler: [guard] }, async (request, reply) => {
    const body = reviewBody.parse(request.body);
    const { order } = await accessibleOrder(request, body.orderId, 'customer');
    const res = await forward<{ id: string; orderId: string; shopId: string; rating: number; comment: string | null; createdAt: string }>(app, request, {
      method: 'POST',
      url: '/customer/reviews',
      body: { orderId: order.id, rating: body.rating, ...(body.comment !== undefined ? { comment: body.comment } : {}) }
    });
    return reply.code(201).send(res.data);
  });
}
