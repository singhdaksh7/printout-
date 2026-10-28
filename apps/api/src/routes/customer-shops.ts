import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { shopCards } from '../domain/discovery.js';
import { DEFAULT_RADIUS_KM, haversineRepository, MAX_RADIUS_KM, type ShopGeoRepository } from '../domain/geo.js';
import { AppError, notFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { customerGuard, json, type AppContext } from './context.js';

const PRINTING_TYPES = { colored: 'colour', blackWhite: 'bw' } as const;

const nearbyQuery = z
  .object({
    lat: z.coerce.number().finite().min(-90).max(90),
    lng: z.coerce.number().finite().min(-180).max(180),
    radiusKm: z.coerce.number().finite().positive().max(MAX_RADIUS_KM).default(DEFAULT_RADIUS_KM),
    printingType: z.enum(['colored', 'blackWhite']).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20)
  })
  .strict();

const shopIdParam = z.object({ shopId: z.string().min(8).max(64) }).strict();
const imageParams = z.object({ shopId: z.string().min(8).max(64), imageId: z.string().min(8).max(64) }).strict();

/**
 * Customer shop discovery (schema-v2 phase 2; NEW routes, customer session only). Only verified, ACTIVE shops are ever returned or
 * served: an unverified, blocked or unknown shop is a 404 so discovery cannot be used to probe other states. No owner data is exposed.
 * `geo` is injectable so a PostGIS-backed repository can replace the portable haversine one without touching the routes.
 */
export async function customerShopRoutes(app: FastifyInstance, ctx: AppContext, geo: ShopGeoRepository = haversineRepository(ctx.prisma)): Promise<void> {
  const { prisma, config, storage } = ctx;
  const limits = getLimiters(app, config);
  const guard = customerGuard(ctx);
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.get('/customer/shops/nearby', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const q = nearbyQuery.parse(request.query);
    const { rows, total } = await geo.nearby({
      lat: q.lat,
      lng: q.lng,
      radiusKm: q.radiusKm,
      ...(q.printingType ? { colourMode: PRINTING_TYPES[q.printingType] } : {}),
      limit: q.limit,
      offset: (q.page - 1) * q.limit
    });
    const cards = await shopCards(prisma, rows.map((r) => r.id));
    const items = rows.flatMap((r) => {
      const c = cards.get(r.id);
      return c ? [{ ...c, distanceKm: r.distanceKm }] : [];
    });
    // Open shops are not promoted over closed ones: the contract is distance order; closed shops are listed and marked.
    return json({ items, page: q.page, limit: q.limit, total });
  });

  async function visibleShopId(shopId: string): Promise<string> {
    const shop = await prisma.shop.findFirst({ where: { id: shopId, isVerified: true, status: 'ACTIVE' }, select: { id: true } });
    if (!shop) throw notFound('Shop not found');
    return shop.id;
  }

  app.get('/customer/shops/:shopId', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const { shopId } = shopIdParam.parse(request.params);
    const id = await visibleShopId(shopId);
    const card = (await shopCards(prisma, [id], { includeLocation: true })).get(id);
    if (!card) throw notFound('Shop not found');
    return json(card);
  });

  /** Serves one private shop photo through the API (authenticated; never a storage URL). */
  app.get('/customer/shops/:shopId/images/:imageId', { preHandler: [guard, limits.documentAccess] }, async (request, reply) => {
    const { shopId, imageId } = imageParams.parse(request.params);
    const id = await visibleShopId(shopId);
    const image = await prisma.shopImage.findFirst({ where: { id: imageId, shopId: id } });
    if (!image) throw notFound('Image not found');
    const stream = await storage.openRead(image.imageKey).catch(() => null);
    if (!stream) throw new AppError(404, 'NOT_FOUND', 'Image not found');
    reply.header('content-type', image.contentType);
    reply.header('cache-control', 'private, max-age=300');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(stream);
  });
}
