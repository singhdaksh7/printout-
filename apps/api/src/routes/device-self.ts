import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deviceGuard, deviceOf } from '../device-auth.js';
import { HEARTBEAT_INTERVAL_SECONDS } from '../domain/device-presence.js';
import { AppError } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { audit, json, type AppContext } from './context.js';

const heartbeatBody = z
  .object({
    appVersion: z.string().trim().min(1).max(40).optional(),
    osVersion: z.string().trim().min(1).max(60).optional()
  })
  .strict();

const pushTokenBody = z.object({ token: z.string().trim().min(20).max(4096) }).strict();

/** Device-authenticated self APIs: /device/heartbeat, /device/push-token, /device/me. */
export async function deviceSelfRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  const guard = deviceGuard(ctx);

  app.post('/device/heartbeat', { preHandler: [guard, limits.deviceMutation] }, async (request) => {
    const me = deviceOf(request);
    const body = heartbeatBody.parse(request.body ?? {});
    const now = new Date();
    const stored = await prisma.shopDevice.findUnique({
      where: { id: me.deviceId },
      select: { appVersion: true, osVersion: true }
    });
    const versionChanged =
      !!stored &&
      ((body.appVersion !== undefined && body.appVersion !== stored.appVersion) ||
        (body.osVersion !== undefined && body.osVersion !== stored.osVersion));
    if (versionChanged) {
      await prisma.shopDevice.update({
        where: { id: me.deviceId },
        data: {
          lastSeenAt: now,
          ...(body.appVersion !== undefined ? { appVersion: body.appVersion } : {}),
          ...(body.osVersion !== undefined ? { osVersion: body.osVersion } : {})
        }
      });
    } else {
      // Throttled: a conditional write, so concurrent heartbeats cannot stampede the row.
      const staleBefore = new Date(now.getTime() - config.DEVICE_LASTSEEN_WRITE_INTERVAL_SECONDS * 1000);
      await prisma.shopDevice.updateMany({
        where: { id: me.deviceId, status: 'ACTIVE', OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: staleBefore } }] },
        data: { lastSeenAt: now }
      });
    }
    return json({
      serverTime: now,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      device: { id: me.deviceId, name: me.name }
    });
  });

  app.put('/device/push-token', { preHandler: [guard, limits.deviceMutation] }, async (request) => {
    const me = deviceOf(request);
    if (me.platform !== 'ANDROID') {
      throw new AppError(409, 'CONFLICT', 'Push tokens are only supported for Android devices');
    }
    const { token } = pushTokenBody.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const current = await tx.shopDevice.findUnique({ where: { id: me.deviceId }, select: { pushToken: true } });
      if (current?.pushToken === token) return; // idempotent: no write, no audit
      // A token maps to exactly one device: clear it from any other row (e.g. after re-pairing).
      await tx.shopDevice.updateMany({
        where: { pushToken: token, id: { not: me.deviceId } },
        data: { pushToken: null, pushTokenUpdatedAt: null }
      });
      await tx.shopDevice.update({ where: { id: me.deviceId }, data: { pushToken: token, pushTokenUpdatedAt: new Date() } });
      await audit(tx, {
        shopId: me.shopId,
        actorUserId: null,
        actorType: 'SHOP_DEVICE',
        actorDeviceId: me.deviceId,
        action: 'device.pushTokenUpdated',
        targetType: 'ShopDevice',
        targetId: me.deviceId,
        metadata: { changed: true }
      });
    });
    return json({ ok: true });
  });

  app.get('/device/me', { preHandler: [guard, limits.deviceRead] }, async (request) => {
    const me = deviceOf(request);
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: me.shopId }, select: { displayName: true } });
    return json({ device: { id: me.deviceId, name: me.name, platform: me.platform, shopName: shop.displayName } });
  });
}
