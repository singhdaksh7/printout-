import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createPairingCode, listDevices, renameDevice, revokeDevice } from '../domain/devices.js';
import { getLimiters } from '../rate-limits.js';
import { authOf, idParam, json, shopGuard, shopIdOf, type AppContext } from './context.js';

const renameBody = z.object({ name: z.string().trim().min(1).max(60) }).strict();
const emptyBody = z.object({}).strict();

/** Shop-owner device management: /shop/devices (list, pairing-codes, rename, revoke). Owner: Agent 1. */
export async function shopDeviceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  const actor = (request: FastifyRequest) => ({ shopId: shopIdOf(request), userId: authOf(request).userId });

  // Encapsulated so the shop-session guard only applies to /shop/devices*.
  await app.register(async (scope) => {
    scope.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
    scope.addHook('preHandler', shopGuard(ctx));

    scope.get('/shop/devices', { preHandler: limits.shopRead }, async (request) =>
      json({ devices: await listDevices(prisma, shopIdOf(request)) })
    );

    scope.post('/shop/devices/pairing-codes', { preHandler: limits.shopMutation }, async (request) => {
      emptyBody.parse(request.body ?? {});
      return json(await createPairingCode(prisma, config, actor(request)));
    });

    scope.patch('/shop/devices/:id', { preHandler: limits.shopMutation }, async (request) => {
      const { id } = idParam.parse(request.params);
      const { name } = renameBody.parse(request.body);
      return json({ device: await renameDevice(prisma, actor(request), id, name) });
    });

    scope.post('/shop/devices/:id/revoke', { preHandler: limits.shopMutation }, async (request) => {
      const { id } = idParam.parse(request.params);
      emptyBody.parse(request.body ?? {});
      return json({ device: await revokeDevice(prisma, actor(request), id) });
    });
  });
}
