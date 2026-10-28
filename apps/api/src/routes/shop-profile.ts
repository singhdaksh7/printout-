import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { shopCards, SUPPORTED_PAPER_TYPES } from '../domain/discovery.js';
import { requireOwnedShop } from '../domain/shop-access.js';
import { AppError, notFound } from '../errors.js';
import { generateObjectKey } from '../storage/index.js';
import { getLimiters } from '../rate-limits.js';
import { assertCsrf, audit, authOf, authenticate, json, type AppContext } from './context.js';
import { PINCODE } from './profile.js';
import { dbPaymentMethod, UPI_ID } from '../domain/payments.js';

export const MAX_SHOP_IMAGES = 8;
export const MAX_SHOP_IMAGE_BYTES = 2 * 1024 * 1024;

/** Real image type from magic bytes (the declared Content-Type is never trusted). */
export function sniffImage(buf: Buffer): { mime: 'image/jpeg' | 'image/png'; ext: 'jpg' | 'png' } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  return null;
}

const shopParam = z.object({ shopId: z.string().min(8).max(64) }).strict();
const imageParam = z.object({ shopId: z.string().min(8).max(64), imageId: z.string().min(8).max(64) }).strict();
const coordinate = (min: number, max: number) => z.number().finite().min(min).max(max);

const patchBody = z
  .object({
    shopName: z.string().trim().min(2).max(100).optional(),
    phoneNumber: z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/, 'Use international format, e.g. +919999999999').nullable().optional(),
    addressLine1: z.string().trim().min(5).max(300).optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    pincode: z.string().trim().regex(PINCODE, 'Enter a valid 6-digit PIN code').optional(),
    latitude: coordinate(-90, 90).optional(),
    longitude: coordinate(-180, 180).optional(),
    /** The owner's open/closed switch (maps to Shop.acceptsOrders). */
    isOpen: z.boolean().optional(),
    /** Where UPI customers pay (e.g. ramesh@upi). Null removes it (and UPI with it). */
    upiId: z.string().trim().regex(UPI_ID, 'Enter a valid UPI ID such as name@bank').nullable().optional(),
    acceptedPaymentMethods: z.array(z.enum(['cash', 'upi'])).min(1).max(2).optional()
  })
  .strict()
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), { message: 'latitude and longitude must be sent together', path: ['latitude'] })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update.' });

const PAPER_SIZE = z.string().trim().min(1).max(20);
const paperBody = z
  .object({
    paperSizes: z.array(PAPER_SIZE).max(10),
    paperTypes: z.array(z.string().trim().min(1).max(30)).max(10)
  })
  .strict();

/**
 * Owner shop profile (schema-v2 phase 2, NEW routes under /shops/{shopId}). Every handler resolves the shop through requireOwnedShop:
 * the caller's own default shop or an OWNER membership, nothing else (a foreign id is a 404). isVerified, status and isActive are
 * admin-only and rejected by the strict bodies. Cookie sessions need the CSRF header; bearer sessions do not.
 */
export async function shopProfileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, storage } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  const ownerGuard = async (request: import('fastify').FastifyRequest) => {
    const auth = await authenticate(ctx, request);
    if (auth.role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'Shop account required');
    if (request.method !== 'GET') assertCsrf(ctx, request, auth);
  };

  // Raw image bodies (<= 2 MiB, buffered so the magic bytes can be checked before anything is stored).
  app.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: MAX_SHOP_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  const ownerView = async (shopId: string) => {
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    const card = (await shopCards(prisma, [shopId], { includeLocation: true })).get(shopId);
    return {
      ...card,
      shopStatus: shop.status,
      isActive: shop.status === 'ACTIVE',
      isVerified: shop.isVerified,
      verifiedAt: shop.verifiedAt,
      country: shop.country,
      slug: shop.slug
    };
  };

  app.get('/shops/:shopId', { preHandler: [ownerGuard, limits.shopRead] }, async (request) => {
    const { shopId } = shopParam.parse(request.params);
    await requireOwnedShop(prisma, authOf(request).userId, shopId);
    return json(await ownerView(shopId));
  });

  app.patch('/shops/:shopId', { preHandler: [ownerGuard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const { shopId } = shopParam.parse(request.params);
    const owned = await requireOwnedShop(prisma, auth.userId, shopId);
    const body = patchBody.parse(request.body);
    await prisma.$transaction(async (tx) => {
      if (body.isOpen === true) {
        // Opening needs a live shop with at least one active rate (a closed switch is always allowed).
        if (owned.status !== 'ACTIVE') throw new AppError(422, 'SHOP_NOT_ACTIVE', 'This shop cannot open until it is active.');
        const rates = await tx.pricingRule.count({ where: { shopId, active: true } });
        if (rates === 0) throw new AppError(422, 'RATE_NOT_SET', 'Set at least one price before opening the shop.');
      }
      const { phoneNumber, isOpen, addressLine1, shopName, latitude, longitude, acceptedPaymentMethods, ...rest } = body;
      if (acceptedPaymentMethods !== undefined || body.upiId !== undefined) {
        const current = await tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: { upiId: true, acceptedPaymentMethods: true } });
        const methods = acceptedPaymentMethods ? [...new Set(acceptedPaymentMethods.map(dbPaymentMethod))] : current.acceptedPaymentMethods;
        const upi = body.upiId !== undefined ? body.upiId : current.upiId;
        if (methods.includes('UPI') && !upi) throw new AppError(400, 'VALIDATION_ERROR', 'Set a UPI ID to accept UPI payments', { field: 'upiId' });
        if (upi === null && methods.includes('UPI')) throw new AppError(400, 'VALIDATION_ERROR', 'Remove UPI from accepted methods before removing the UPI ID', { field: 'upiId' });
        (rest as Record<string, unknown>).acceptedPaymentMethods = methods;
      }
      await tx.shop.update({
        where: { id: shopId },
        data: {
          ...rest,
          ...(shopName !== undefined ? { displayName: shopName } : {}),
          ...(addressLine1 !== undefined ? { address: addressLine1 } : {}),
          ...(isOpen !== undefined ? { acceptsOrders: isOpen } : {}),
          ...(latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {})
        }
      });
      if (phoneNumber !== undefined) await tx.shopSettings.upsert({ where: { shopId }, create: { shopId, publicContact: phoneNumber }, update: { publicContact: phoneNumber } });
      await audit(tx, { shopId, actorUserId: auth.userId, actorType: 'SHOP_OWNER', action: 'shop.profile.updated', targetType: 'shop', targetId: shopId, metadata: { fields: Object.keys(body) } });
    });
    return json(await ownerView(shopId));
  });

  /**
   * Replaces the advertised paper options atomically. A size may be advertised only if the shop has an active rate for it, and the
   * only paper type priced today is plain paper: anything else is refused instead of being advertised at a price that does not exist.
   */
  app.put('/shops/:shopId/paper-options', { preHandler: [ownerGuard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const { shopId } = shopParam.parse(request.params);
    await requireOwnedShop(prisma, auth.userId, shopId);
    const body = paperBody.parse(request.body);
    const sizes = [...new Set(body.paperSizes)];
    const types = [...new Set(body.paperTypes)];
    if (sizes.length !== body.paperSizes.length || types.length !== body.paperTypes.length) throw new AppError(400, 'VALIDATION_ERROR', 'Duplicate paper option', { field: 'paperSizes' });
    const unsupportedType = types.find((t) => !(SUPPORTED_PAPER_TYPES as readonly string[]).includes(t));
    if (unsupportedType) throw new AppError(400, 'UNSUPPORTED_PAPER', `Paper type "${unsupportedType}" is not supported yet`, { field: 'paperTypes' });
    await prisma.$transaction(async (tx) => {
      const priced = new Set((await tx.pricingRule.findMany({ where: { shopId, active: true }, select: { paperSize: true } })).map((r) => r.paperSize));
      const unpriced = sizes.find((s) => !priced.has(s));
      if (unpriced) throw new AppError(400, 'UNSUPPORTED_PAPER', `Set a price for paper size "${unpriced}" first`, { field: 'paperSizes' });
      await tx.shopPaperOption.deleteMany({ where: { shopId } });
      if (sizes.length || types.length) {
        await tx.shopPaperOption.createMany({ data: [...sizes.map((value) => ({ shopId, kind: 'paperSize', value })), ...types.map((value) => ({ shopId, kind: 'paperType', value }))] });
      }
      await audit(tx, { shopId, actorUserId: auth.userId, actorType: 'SHOP_OWNER', action: 'shop.paper_options.updated', targetType: 'shop', targetId: shopId, metadata: { paperSizes: sizes, paperTypes: types } });
    });
    return json({ shopId, paperSizes: sizes, paperTypes: types.length > 0 ? types : [...SUPPORTED_PAPER_TYPES] });
  });

  app.post('/shops/:shopId/images', { preHandler: [ownerGuard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const { shopId } = shopParam.parse(request.params);
    await requireOwnedShop(prisma, auth.userId, shopId);
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError(400, 'INVALID_FILE_TYPE', 'Send the image as the request body with Content-Type image/jpeg or image/png.');
    const kind = sniffImage(body);
    if (!kind) throw new AppError(400, 'INVALID_FILE_TYPE', 'Only JPEG and PNG images are accepted.');
    if ((await prisma.shopImage.count({ where: { shopId } })) >= MAX_SHOP_IMAGES) throw new AppError(409, 'CONFLICT', `A shop can have at most ${MAX_SHOP_IMAGES} photos.`);
    // Opaque random key like every other object (the storage layer refuses structured keys); shop ownership lives in ShopImage.shopId.
    const imageKey = generateObjectKey();
    await storage.put(imageKey, Readable.from(body), { maxBytes: MAX_SHOP_IMAGE_BYTES, contentType: kind.mime });
    try {
      const last = await prisma.shopImage.aggregate({ where: { shopId }, _max: { sortOrder: true } });
      const image = await prisma.shopImage.create({ data: { shopId, imageKey, contentType: kind.mime, sizeBytes: body.length, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
      await audit(prisma, { shopId, actorUserId: auth.userId, actorType: 'SHOP_OWNER', action: 'shop.image.added', targetType: 'shop', targetId: shopId, metadata: { imageId: image.id, bytes: body.length } });
      reply.code(201);
      return json({ id: image.id, url: `/customer/shops/${shopId}/images/${image.id}`, sortOrder: image.sortOrder });
    } catch (error) {
      await storage.delete(imageKey).catch(() => undefined);
      throw error;
    }
  });

  app.get('/shops/:shopId/images/:imageId', { preHandler: [ownerGuard, limits.documentAccess] }, async (request, reply) => {
    const { shopId, imageId } = imageParam.parse(request.params);
    await requireOwnedShop(prisma, authOf(request).userId, shopId);
    const image = await prisma.shopImage.findFirst({ where: { id: imageId, shopId } });
    if (!image) throw notFound('Image not found');
    const stream = await storage.openRead(image.imageKey).catch(() => null);
    if (!stream) throw notFound('Image not found');
    reply.header('content-type', image.contentType);
    reply.header('cache-control', 'private, max-age=300');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(stream);
  });

  app.delete('/shops/:shopId/images/:imageId', { preHandler: [ownerGuard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const { shopId, imageId } = imageParam.parse(request.params);
    await requireOwnedShop(prisma, auth.userId, shopId);
    const image = await prisma.shopImage.findFirst({ where: { id: imageId, shopId } });
    if (!image) throw notFound('Image not found');
    await prisma.shopImage.delete({ where: { id: image.id } });
    await storage.delete(image.imageKey).catch(() => undefined);
    await audit(prisma, { shopId, actorUserId: auth.userId, actorType: 'SHOP_OWNER', action: 'shop.image.removed', targetType: 'shop', targetId: shopId, metadata: { imageId } });
    return reply.code(204).send();
  });
}
