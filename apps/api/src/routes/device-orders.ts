import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deviceGuard, deviceOf } from '../device-auth.js';
import { listOrders, orderDetail, orderListQuery } from '../domain/order-serializers.js';
import { initiatePrint, issueDocumentAccess, type PrintActor } from '../domain/print-service.js';
import { orderNotFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { idParam, json, type AppContext } from './context.js';

const printBody = z.object({ clientRequestId: z.string().uuid() }).strict();
const emptyBody = z.object({}).strict();

/**
 * Device-authenticated order APIs: /device/orders (list, detail, print, reprint, download).
 * Tenant = the device's shop ONLY (deviceOf); no shop id is ever read from the body/query. All business logic lives in
 * domain/print-service.ts and domain/order-serializers.ts (shared with the browser routes).
 */
export async function deviceOrderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  const guard = deviceGuard(ctx);
  const read = { preHandler: [guard, limits.deviceRead] };
  const mutate = { preHandler: [guard, limits.deviceMutation] };
  const actorOf = (request: Parameters<typeof deviceOf>[0]): { shopId: string; actor: PrintActor } => {
    const d = deviceOf(request);
    return { shopId: d.shopId, actor: { type: 'SHOP_DEVICE', deviceId: d.deviceId } };
  };

  app.get('/device/orders', read, async (request) => {
    const { shopId } = actorOf(request);
    return json(await listOrders(prisma, shopId, orderListQuery.parse(request.query)));
  });

  app.get('/device/orders/:id', read, async (request) => {
    const { shopId } = actorOf(request);
    const { id } = idParam.parse(request.params);
    const order = await prisma.order.findFirst({
      where: { id, shopId },
      include: { document: true, histories: { orderBy: { createdAt: 'asc' } } }
    });
    if (!order) throw orderNotFound();
    return json(orderDetail(order));
  });

  app.post('/device/orders/:id/print', mutate, async (request) => {
    const { shopId, actor } = actorOf(request);
    const { id } = idParam.parse(request.params);
    const body = printBody.parse(request.body);
    return json(await initiatePrint(ctx, { actor, shopId, orderId: id, clientRequestId: body.clientRequestId }));
  });

  app.post('/device/orders/:id/reprint', mutate, async (request) => {
    const { shopId, actor } = actorOf(request);
    const { id } = idParam.parse(request.params);
    emptyBody.parse(request.body ?? {});
    return json(await issueDocumentAccess(ctx, { actor, shopId, orderId: id, disposition: 'inline', requirePrintInitiated: true }));
  });

  app.post('/device/orders/:id/download', mutate, async (request) => {
    const { shopId, actor } = actorOf(request);
    const { id } = idParam.parse(request.params);
    emptyBody.parse(request.body ?? {});
    return json(await issueDocumentAccess(ctx, { actor, shopId, orderId: id, disposition: 'attachment' }));
  });
}
