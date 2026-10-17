import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { evaluateAvailability, isValidTimezone, parseStoredHours, specialClosuresSchema, weeklyHoursSchema } from '../domain/hours.js';
import { publicAvailability } from '../domain/hours-view.js';
import { AppError } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { audit, authOf, json, shopGuard, shopIdOf, type AppContext } from './context.js';

const hoursBody = z
  .object({
    timezone: z.string().refine(isValidTimezone, 'Unknown timezone'),
    // null = remove the schedule (explicit); omitted = leave untouched.
    weeklyHours: weeklyHoursSchema.nullable(),
    specialClosures: specialClosuresSchema,
    afterHoursPolicy: z.enum(['ACCEPT', 'BLOCK'])
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

const MAX_FUTURE_MS = 366 * 86_400_000;
const closureBody = z
  .object({
    reason: z.string().trim().max(200).nullable().optional(),
    until: z.coerce.date().nullable().optional()
  })
  .strict();
const reopenBody = z.object({ minutes: z.number().int().min(5).max(24 * 60) }).strict();

export async function shopHoursRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  app.addHook('preHandler', shopGuard(ctx));

  async function view(shopId: string, now = new Date()) {
    const row = await prisma.shopSettings.findUnique({ where: { shopId } });
    const cfg = parseStoredHours(row);
    const pub = publicAvailability(row, now);
    return {
      timezone: cfg.timezone,
      weeklyHours: cfg.operatingHours,
      specialClosures: cfg.specialClosures,
      afterHoursPolicy: row?.afterHoursPolicy ?? 'ACCEPT',
      temporaryClosure: cfg.temporaryClosure,
      reopenUntil: cfg.reopenUntil && cfg.reopenUntil > now ? cfg.reopenUntil.toISOString() : null,
      updatedAt: row?.updatedAt ?? null,
      availability: { ...evaluateAvailability(cfg, now), orderingBlocked: pub.orderingBlocked, serverTime: pub.serverTime }
    };
  }

  /**
   * Every mutation locks the shop row first. The public order transaction takes the same lock (order counter), so an
   * order is evaluated either entirely before or entirely after a settings change.
   */
  async function mutate(shopId: string, actorUserId: string, action: string, metadata: Prisma.InputJsonValue, data: Prisma.ShopSettingsUncheckedUpdateInput) {
    await prisma.$transaction(async (tx) => {
      await tx.shop.update({ where: { id: shopId }, data: { updatedAt: new Date() } });
      await tx.shopSettings.upsert({ where: { shopId }, create: { ...(data as Prisma.ShopSettingsUncheckedCreateInput), shopId }, update: data });
      await audit(tx, { shopId, actorUserId, action, targetType: 'shop', targetId: shopId, metadata });
    });
  }

  app.get('/shop/hours', { preHandler: limits.shopRead }, async (request) => json(await view(shopIdOf(request))));

  app.put('/shop/hours', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    const body = hoursBody.parse(request.body);
    const data: Prisma.ShopSettingsUncheckedUpdateInput = {};
    if (body.timezone !== undefined) data.timezone = body.timezone;
    if (body.weeklyHours !== undefined) data.operatingHours = body.weeklyHours === null ? Prisma.DbNull : (body.weeklyHours as Prisma.InputJsonValue);
    if (body.specialClosures !== undefined) data.specialClosures = body.specialClosures.map((c) => ({ date: c.date, reason: c.reason || null }));
    if (body.afterHoursPolicy !== undefined) data.afterHoursPolicy = body.afterHoursPolicy;
    await mutate(shopId, authOf(request).userId, 'shop.hours.update', { fields: Object.keys(body) }, data);
    return json(await view(shopId));
  });

  app.put('/shop/hours/temporary-closure', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    const body = closureBody.parse(request.body);
    const now = new Date();
    if (body.until && (body.until.getTime() <= now.getTime() || body.until.getTime() > now.getTime() + MAX_FUTURE_MS)) {
      throw new AppError(400, 'VALIDATION_ERROR', '`until` must be in the future (within a year)');
    }
    const closure = { reason: body.reason || null, startedAt: now.toISOString(), until: body.until ? body.until.toISOString() : null };
    // Starting a closure also ends any emergency reopen, otherwise the closure would have no visible effect.
    await mutate(shopId, authOf(request).userId, 'shop.hours.temporary_closure.set', { until: closure.until }, { temporaryClosure: closure, reopenUntil: null });
    return json(await view(shopId));
  });

  app.delete('/shop/hours/temporary-closure', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    await mutate(shopId, authOf(request).userId, 'shop.hours.temporary_closure.clear', {}, { temporaryClosure: Prisma.DbNull });
    return json(await view(shopId));
  });

  app.post('/shop/hours/reopen', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    const body = reopenBody.parse(request.body);
    const until = new Date(Date.now() + body.minutes * 60_000);
    await mutate(shopId, authOf(request).userId, 'shop.hours.reopen', { until: until.toISOString() }, { reopenUntil: until });
    return json(await view(shopId));
  });

  app.delete('/shop/hours/reopen', { preHandler: limits.shopMutation }, async (request) => {
    const shopId = shopIdOf(request);
    await mutate(shopId, authOf(request).userId, 'shop.hours.reopen.clear', {}, { reopenUntil: null });
    return json(await view(shopId));
  });
}
