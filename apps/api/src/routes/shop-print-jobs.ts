import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cancelJob, enqueuePrintJob, listShopJobs, reconcileJob, retryJob, updatePrinterSettings } from '../domain/print-jobs.js';
import { getLimiters } from '../rate-limits.js';
import { authOf, idParam, json, shopGuard, shopIdOf, type AppContext } from './context.js';

const enqueueBody = z
  .object({
    clientRequestId: z.string().uuid(),
    printerId: z.string().min(8).max(64).optional(),
    reprint: z.boolean().optional(),
    acknowledgeDuplicateRisk: z.boolean().optional()
  })
  .strict();
const retryBody = z.object({ clientRequestId: z.string().uuid(), acknowledgeDuplicateRisk: z.boolean().optional() }).strict();
const reconcileBody = z
  .object({ resolution: z.enum(['PRINTED', 'NOT_PRINTED_REQUEUE', 'NOT_PRINTED_GIVE_UP']), clientRequestId: z.string().uuid().optional() })
  .strict();
const printerPatch = z
  .object({ authorized: z.boolean().optional(), isDefault: z.boolean().optional() })
  .strict()
  .refine((v) => v.authorized !== undefined || v.isDefault !== undefined, 'Nothing to change');
const printerParams = z.object({ id: z.string().min(8).max(64), printerId: z.string().min(8).max(64) }).strict();
const listQuery = z.object({ orderId: z.string().min(8).max(64).optional() }).strict();
const emptyBody = z.object({}).strict();

/** Shop-owner side of the Windows print queue: printer authorization, enqueue, list, cancel, retry, reconcile. */
export async function shopPrintJobRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config } = ctx;
  const limits = getLimiters(app, config);
  const actor = (request: FastifyRequest) => ({ shopId: shopIdOf(request), userId: authOf(request).userId });

  await app.register(async (scope) => {
    scope.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
    scope.addHook('preHandler', shopGuard(ctx));

    scope.patch('/shop/devices/:id/printers/:printerId', { preHandler: limits.shopMutation }, async (request) => {
      const { id, printerId } = printerParams.parse(request.params);
      return json({ printer: await updatePrinterSettings(ctx.prisma, actor(request), id, printerId, printerPatch.parse(request.body)) });
    });

    scope.post('/shop/orders/:id/print-jobs', { preHandler: limits.shopMutation }, async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const a = actor(request);
      const result = await enqueuePrintJob(ctx, { shopId: a.shopId, userId: a.userId, orderId: id, ...enqueueBody.parse(request.body) });
      reply.code(result.created ? 201 : 200);
      return json({ job: result.job, created: result.created });
    });

    scope.get('/shop/print-jobs', { preHandler: limits.shopRead }, async (request) => {
      const q = listQuery.parse(request.query);
      return json({ jobs: await listShopJobs(ctx, shopIdOf(request), q) });
    });

    scope.post('/shop/print-jobs/:id/cancel', { preHandler: limits.shopMutation }, async (request) => {
      const { id } = idParam.parse(request.params);
      emptyBody.parse(request.body ?? {});
      return json({ job: await cancelJob(ctx, actor(request), id) });
    });

    scope.post('/shop/print-jobs/:id/retry', { preHandler: limits.shopMutation }, async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const result = await retryJob(ctx, actor(request), id, retryBody.parse(request.body));
      reply.code(result.created ? 201 : 200);
      return json({ job: result.job, created: result.created });
    });

    scope.post('/shop/print-jobs/:id/reconcile', { preHandler: limits.shopMutation }, async (request) => {
      const { id } = idParam.parse(request.params);
      return json(await reconcileJob(ctx, actor(request), id, reconcileBody.parse(request.body)));
    });
  });
}
