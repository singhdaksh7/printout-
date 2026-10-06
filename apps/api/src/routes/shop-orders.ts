import { OrderStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listOrders, orderCore, orderDetail, orderListQuery, toStatusEvent } from '../domain/order-serializers.js';
import { initiatePrint, issueDocumentAccess } from '../domain/print-service.js';
import { assertRequestedTransition } from '../domain/lifecycle.js';
import { AppError, orderNotFound } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import {
  audit,
  authOf,
  idParam,
  json,
  shopGuard,
  shopIdOf,
  type AppContext
} from './context.js';

const transitionBody = z
  .object({
    // Shop owners can only cancel. Accept / Start printing / Ready / Collected are retired: Print (print-now) performs the
    // internal NEW -> ACCEPTED -> PRINTING steps itself. Legacy PRINTED/READY/COLLECTED rows remain readable.
    toStatus: z.literal(OrderStatus.CANCELLED),
    reason: z.string().trim().max(250).optional(),
    clientRequestId: z.string().uuid()
  })
  .strict();

const confirmBody = z.object({ clientRequestId: z.string().uuid() }).strict();
const printNowBody = z.object({ clientRequestId: z.string().uuid() }).strict();

export async function shopOrderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, events } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  app.addHook('preHandler', shopGuard(ctx));

  app.get('/shop/orders', { preHandler: limits.shopRead }, async (request) => {
    const shopId = shopIdOf(request);
    const q = orderListQuery.parse(request.query);
    return json(await listOrders(prisma, shopId, q));
  });

  app.get('/shop/orders/:id', { preHandler: limits.shopRead }, async (request) => {
    const shopId = shopIdOf(request);
    const { id } = idParam.parse(request.params);
    const order = await prisma.order.findFirst({
      where: { id, shopId },
      include: { document: true, histories: { orderBy: { createdAt: 'asc' } } }
    });
    if (!order) throw orderNotFound();
    return json(orderDetail(order));
  });

  app.post('/shop/orders/:id/transitions', { preHandler: limits.status }, async (request) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    const body = transitionBody.parse(request.body);

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id, shopId }, include: { document: true } });
      if (!order) throw orderNotFound();
      if (order.status === body.toStatus) return { order, changed: false };
      const from = order.status;
      assertRequestedTransition(from, body.toStatus);

      const updated = await tx.order.updateMany({ where: { id, shopId, status: from }, data: { status: body.toStatus } });
      if (updated.count !== 1) {
        throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Order status changed concurrently; reload and retry');
      }
      await tx.orderStatusHistory.create({
        data: { orderId: id, fromStatus: from, toStatus: body.toStatus, reason: body.reason ?? null, actorUserId: auth.userId }
      });
      await audit(tx, {
        shopId,
        actorUserId: auth.userId,
        action: 'order.transition',
        targetType: 'order',
        targetId: id,
        metadata: { from, to: body.toStatus }
      });
      const fresh = await tx.order.findFirstOrThrow({ where: { id, shopId } });
      return { order: fresh, changed: true };
    });

    if (result.changed) {
      events.emit(shopId, 'order.statusChanged', toStatusEvent(result.order));
      events.emit(shopId, 'order.updated', toStatusEvent(result.order));
    }
    return json({ order: orderCore(result.order) });
  });

  /**
   * "Print": the ONE shop action (see domain/print-service.ts). The FIRST successful call starts the retention window;
   * everything after is access only. Failure rule: the access URL is produced BEFORE the transaction, so a failure starts nothing.
   */
  app.post('/shop/orders/:id/print-now', { preHandler: limits.status }, async (request) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    const body = printNowBody.parse(request.body);
    return json(
      await initiatePrint(ctx, { actor: { type: 'SHOP_OWNER', userId: auth.userId }, shopId, orderId: id, clientRequestId: body.clientRequestId })
    );
  });

  /**
   * RETIRED. "Confirm printed" is not a shop-owner concept any more: the browser cannot prove paper came out, so the only
   * signal is "Print initiated" (print-now). Existing PRINTED rows stay readable; nothing can create new ones here.
   */
  app.post('/shop/orders/:id/print-confirmation', { preHandler: limits.printConfirm }, async (request) => {
    shopIdOf(request);
    throw new AppError(410, 'ENDPOINT_RETIRED', 'Print confirmation has been retired. Use Print (print-now); retention starts when Print is initiated.');
  });

  /** Shared by document-access (inline, for printing) and document-download (attachment, explicit "Save File"). */
  async function issueDocumentUrl(request: import('fastify').FastifyRequest, disposition: 'inline' | 'attachment') {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    return issueDocumentAccess(ctx, {
      actor: { type: 'SHOP_OWNER', userId: auth.userId },
      shopId,
      orderId: id,
      disposition,
      requirePrintInitiated: false // Phase 1 browser behaviour: unprinted documents stay openable until their 24h expiry
    });
  }

  app.post('/shop/orders/:id/document-access', { preHandler: limits.documentAccess }, async (request) =>
    json(await issueDocumentUrl(request, 'inline'))
  );

  /** Explicit "Save File": a short-lived ATTACHMENT url for the original document. Never automatic, never extends retention. */
  app.post('/shop/orders/:id/document-download', { preHandler: limits.documentAccess }, async (request) =>
    json(await issueDocumentUrl(request, 'attachment'))
  );
}
