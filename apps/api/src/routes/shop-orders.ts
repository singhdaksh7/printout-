import { DocumentStatus, OrderStatus, type Document, type Order, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertRequestedTransition, retentionDates, TERMINAL_STATUSES } from '../domain/lifecycle.js';
import { AppError, orderNotFound } from '../errors.js';
import {
  audit,
  authOf,
  cursorWhere,
  decodeCursor,
  encodeCursor,
  idParam,
  json,
  shopGuard,
  shopIdOf,
  type AppContext
} from './context.js';

const transitionBody = z
  .object({
    toStatus: z.nativeEnum(OrderStatus),
    reason: z.string().trim().max(250).optional(),
    clientRequestId: z.string().uuid()
  })
  .strict();

const confirmBody = z.object({ clientRequestId: z.string().uuid() }).strict();

const listQuery = z
  .object({
    /** One status or a comma-separated list. */
    status: z.string().max(200).optional(),
    /** active=1 hides terminal orders (COLLECTED, CANCELLED, EXPIRED). */
    active: z.enum(['1', 'true', '0', 'false']).optional(),
    cursor: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  })
  .strict();

interface PriceSnapshot {
  selectedPageCount?: number;
}
interface OptionsSnapshot {
  colourMode?: string;
  sides?: string;
  copies?: number;
  pageSelection?: unknown;
}

const orderCore = (o: Order) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  status: o.status,
  totalPaise: o.totalPaise,
  currency: o.currency,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt
});

function parseStatuses(raw: string | undefined): OrderStatus[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const parsed = z.array(z.nativeEnum(OrderStatus)).min(1).max(8).safeParse(values);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid status filter');
  return parsed.data;
}

const toStatusEvent = (o: Order) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status, updatedAt: o.updatedAt });

export async function shopOrderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, storage, events } = ctx;
  app.addHook('preHandler', shopGuard(ctx));

  app.get('/shop/orders', async (request) => {
    const shopId = shopIdOf(request);
    const q = listQuery.parse(request.query);
    const statuses = parseStatuses(q.status);
    const hideTerminal = q.active === '1' || q.active === 'true';
    const statusFilter: Prisma.OrderWhereInput['status'] = statuses
      ? { in: statuses }
      : hideTerminal
        ? { notIn: TERMINAL_STATUSES as OrderStatus[] }
        : undefined;
    const rows = await prisma.order.findMany({
      where: { shopId, status: statusFilter, ...cursorWhere(decodeCursor(q.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { document: true }
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return json({
      items: page.map((o) => {
        const options = o.printOptionsSnapshot as OptionsSnapshot;
        return {
          ...orderCore(o),
          customerDisplayNameOrReference: o.customerDisplayNameOrReference,
          originalFilename: o.document.originalFilename,
          pageCount: o.document.pageCount,
          selectedPageCount: (o.priceSnapshot as PriceSnapshot).selectedPageCount ?? null,
          colourMode: options.colourMode ?? null,
          sides: options.sides ?? null,
          copies: options.copies ?? null,
          documentStatus: o.document.status,
          deleteAfter: o.document.deleteAfter
        };
      }),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined
    });
  });

  app.get('/shop/orders/:id', async (request) => {
    const shopId = shopIdOf(request);
    const { id } = idParam.parse(request.params);
    const order = await prisma.order.findFirst({
      where: { id, shopId },
      include: { document: true, histories: { orderBy: { createdAt: 'asc' } } }
    });
    if (!order) throw orderNotFound();
    const d = order.document;
    return json({
      order: {
        ...orderCore(order),
        customerDisplayNameOrReference: order.customerDisplayNameOrReference,
        originalFilename: d.originalFilename,
        selectedPageCount: (order.priceSnapshot as PriceSnapshot).selectedPageCount ?? null
      },
      document: {
        id: d.id,
        status: d.status,
        fileName: d.originalFilename,
        mimeType: d.detectedMimeType,
        pageCount: d.pageCount,
        uploadedAt: d.uploadedAt,
        expiresAt: d.expiresAt,
        printedAt: d.printedAt,
        deleteAfter: d.deleteAfter,
        deletedAt: d.deletedAt,
        deletionState: d.status === DocumentStatus.DELETED ? 'DELETED' : d.deletionError ? 'FAILED' : 'OK'
      },
      priceSnapshot: order.priceSnapshot,
      printOptionsSnapshot: order.printOptionsSnapshot,
      statusHistory: order.histories.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        reason: h.reason,
        createdAt: h.createdAt
      }))
    });
  });

  app.post('/shop/orders/:id/transitions', async (request) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    const body = transitionBody.parse(request.body);
    if (body.toStatus === OrderStatus.PRINTED) {
      throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'PRINTED is set only by print confirmation');
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id, shopId }, include: { document: true } });
      if (!order) throw orderNotFound();
      if (order.status === body.toStatus) return { order, changed: false };
      const from = order.status;
      assertRequestedTransition(from, body.toStatus);

      const now = new Date();
      const doc = order.document;
      const docUsable = doc.status === DocumentStatus.AVAILABLE && !!doc.expiresAt && doc.expiresAt > now;
      if (body.toStatus === OrderStatus.EXPIRED) {
        // Expiry rule: only an unprinted order whose document has expired or been removed.
        const docGone = doc.status === DocumentStatus.DELETED || (!!doc.expiresAt && doc.expiresAt <= now && !doc.printedAt);
        if (!docGone) {
          throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Order cannot expire while its document is still available');
        }
      }
      if ((body.toStatus === OrderStatus.ACCEPTED || body.toStatus === OrderStatus.PRINTING) && !docUsable) {
        throw new AppError(409, 'DOCUMENT_UNAVAILABLE', 'The document for this order is no longer available');
      }

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

  app.post('/shop/orders/:id/print-confirmation', async (request) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    confirmBody.parse(request.body);

    const outcome = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id, shopId }, include: { document: true } });
      if (!order) throw orderNotFound();
      const respond = (o: Order, d: Document, first: boolean) => ({ order: o, document: d, first });

      // Idempotent: once printed, always return the ORIGINAL timestamps.
      if (order.document.printedAt) return respond(order, order.document, false);

      if (order.status !== OrderStatus.PRINTING) {
        throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Order must be PRINTING before print confirmation', {
          from: order.status,
          to: OrderStatus.PRINTED
        });
      }
      const now = new Date();
      const dates = retentionDates(now, config.PRINT_RETENTION_MINUTES);
      // Conditional update: only the first concurrent confirmation can win; it also re-checks expiry.
      const claimed = await tx.document.updateMany({
        where: {
          id: order.documentId,
          shopId,
          status: DocumentStatus.AVAILABLE,
          printedAt: null,
          expiresAt: { gt: now }
        },
        data: { status: DocumentStatus.PRINTED_RETENTION, printedAt: dates.printedAt, deleteAfter: dates.deleteAfter }
      });
      if (claimed.count !== 1) {
        const doc = await tx.document.findUniqueOrThrow({ where: { id: order.documentId } });
        if (doc.printedAt) return respond(order, doc, false);
        throw new AppError(409, 'DOCUMENT_UNAVAILABLE', 'The document is no longer available to confirm printing');
      }
      const moved = await tx.order.updateMany({
        where: { id, shopId, status: OrderStatus.PRINTING },
        data: { status: OrderStatus.PRINTED }
      });
      if (moved.count !== 1) {
        throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Order status changed concurrently; reload and retry');
      }
      await tx.orderStatusHistory.create({
        data: { orderId: id, fromStatus: OrderStatus.PRINTING, toStatus: OrderStatus.PRINTED, actorUserId: auth.userId }
      });
      await audit(tx, {
        shopId,
        actorUserId: auth.userId,
        action: 'order.printConfirmed',
        targetType: 'order',
        targetId: id,
        metadata: { printedAt: dates.printedAt.toISOString(), deleteAfter: dates.deleteAfter.toISOString() }
      });
      const fresh = await tx.order.findFirstOrThrow({ where: { id, shopId }, include: { document: true } });
      return respond(fresh, fresh.document, true);
    });

    if (outcome.first) {
      events.emit(shopId, 'order.statusChanged', toStatusEvent(outcome.order));
      events.emit(shopId, 'order.updated', toStatusEvent(outcome.order));
      events.emit(shopId, 'document.deletionScheduled', {
        orderId: outcome.order.id,
        documentId: outcome.document.id,
        deleteAfter: outcome.document.deleteAfter
      });
    }
    return json({
      order: { id: outcome.order.id, orderNumber: outcome.order.orderNumber, status: outcome.order.status },
      document: {
        status: outcome.document.status,
        printedAt: outcome.document.printedAt,
        deleteAfter: outcome.document.deleteAfter
      }
    });
  });

  app.post('/shop/orders/:id/document-access', async (request) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    const order = await prisma.order.findFirst({ where: { id, shopId }, include: { document: true } });
    if (!order) throw orderNotFound();
    const doc = order.document;
    const now = Date.now();
    // The earliest applicable deadline bounds access, independent of whether the cleanup worker has run.
    let deadline: Date | null = null;
    let usable = false;
    if (doc.status === DocumentStatus.PRINTED_RETENTION) {
      deadline = doc.deleteAfter;
      usable = !!deadline;
    } else if (doc.status === DocumentStatus.AVAILABLE) {
      deadline = doc.expiresAt;
      usable = !!deadline && !doc.printedAt;
    }
    if (doc.deleteAfter && doc.deleteAfter.getTime() <= now) usable = false;
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.EXPIRED) usable = false;
    if (!usable || !deadline || !doc.detectedMimeType) {
      throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'The document is no longer available');
    }
    const secondsLeft = Math.floor((deadline.getTime() - now) / 1000);
    if (secondsLeft <= 0) throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'The document is no longer available');
    const access = await storage.temporaryReadUrl(doc.objectKey, Math.min(300, secondsLeft));
    await audit(ctx.prisma, { shopId, actorUserId: auth.userId, action: 'document.access', targetType: 'order', targetId: id });
    return json({
      url: access.url,
      expiresAt: new Date(Math.min(access.expiresAt.getTime(), deadline.getTime())),
      contentDisposition: 'inline',
      mimeType: doc.detectedMimeType
    });
  });
}
