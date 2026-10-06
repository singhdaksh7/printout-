import { DocumentStatus, OrderStatus, type Document, type Order, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { documentAccessWindow } from '../domain/access.js';
import { assertRequestedTransition, retentionDates, TERMINAL_STATUSES } from '../domain/lifecycle.js';
import { AppError, orderNotFound } from '../errors.js';
import { sanitizeFilename } from '../storage/filename.js';
import { getLimiters } from '../rate-limits.js';
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
    // Shop owners can only cancel. Accept / Start printing / Ready / Collected are retired: Print (print-now) performs the
    // internal NEW -> ACCEPTED -> PRINTING steps itself. Legacy PRINTED/READY/COLLECTED rows remain readable.
    toStatus: z.literal(OrderStatus.CANCELLED),
    reason: z.string().trim().max(250).optional(),
    clientRequestId: z.string().uuid()
  })
  .strict();

const confirmBody = z.object({ clientRequestId: z.string().uuid() }).strict();
const printNowBody = z.object({ clientRequestId: z.string().uuid() }).strict();

/** Statuses from which the FIRST Print may start retention: it ends in PRINTING and never goes further. */
const PRINT_INITIATE_FROM: ReadonlySet<OrderStatus> = new Set([OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PRINTING]);
/** Statuses that may (re)open the document for printing while it is still retained (includes legacy confirmed orders). */
const PRINT_ACCESS_FROM: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PRINTING, OrderStatus.PRINTED, OrderStatus.READY, OrderStatus.COLLECTED
]);
const PRINT_NOW_RACE = 'PRINT_NOW_RACE';

const listQuery = z
  .object({
    /** One status or a comma-separated list. */
    status: z.string().max(200).optional(),
    /** active=1 hides terminal orders (COLLECTED, CANCELLED, EXPIRED). */
    active: z.enum(['1', 'true', '0', 'false']).optional(),
    /** pending = Print not yet pressed; initiated = Print pressed (or legacy print-confirmed). */
    print: z.enum(['pending', 'initiated']).optional(),
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
  paperSize?: string;
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
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  app.addHook('preHandler', shopGuard(ctx));

  app.get('/shop/orders', { preHandler: limits.shopRead }, async (request) => {
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
      where: {
        shopId,
        status: statusFilter,
        ...(q.print === 'initiated' ? { document: { OR: [{ printInitiatedAt: { not: null } }, { printedAt: { not: null } }] } } : {}),
        ...(q.print === 'pending' ? { document: { printInitiatedAt: null, printedAt: null } } : {}),
        ...cursorWhere(decodeCursor(q.cursor))
      },
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
          deleteAfter: o.document.deleteAfter,
          printInitiatedAt: o.document.printInitiatedAt ?? o.document.printedAt,
          paperSize: options.paperSize ?? null,
          pageSelection: options.pageSelection ?? null
        };
      }),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined
    });
  });

  app.get('/shop/orders/:id', { preHandler: limits.shopRead }, async (request) => {
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
        printInitiatedAt: d.printInitiatedAt,
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
   * "Print": the ONE shop action. The FIRST successful call starts the retention window; everything after is access only.
   *  - First call: claims the document (AVAILABLE -> PRINTED_RETENTION) with printInitiatedAt = server now and
   *    deleteAfter = printInitiatedAt + PRINT_RETENTION_MINUTES, and moves the order NEW -> ACCEPTED -> PRINTING, all in ONE
   *    transaction. The claim is a conditional update, so concurrent double-clicks produce exactly one winner and the
   *    losers just get access (they never move either timestamp).
   *  - Reprint / reopen / retry: returns fresh inline access bounded by the EXISTING deleteAfter. Never touches
   *    printInitiatedAt or deleteAfter.
   *  - Failure rule: the access URL is produced BEFORE the transaction. If anything fails (tenant, status, availability, URL),
   *    nothing is written and no retention starts.
   *  - printInitiatedAt records that Print was authorised and access given. It does NOT prove paper came out; the order is
   *    never marked PRINTED here and printedAt (legacy "confirmed") is never written.
   */
  app.post('/shop/orders/:id/print-now', { preHandler: limits.status }, async (request) => {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    printNowBody.parse(request.body);
    const retentionMs = config.PRINT_RETENTION_MINUTES * 60_000;

    const attempt = async () => {
      const order0 = await prisma.order.findFirst({ where: { id, shopId }, include: { document: true } });
      if (!order0) throw orderNotFound();
      if (!PRINT_ACCESS_FROM.has(order0.status)) {
        throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Print is not available for this order', { from: order0.status, to: OrderStatus.PRINTING });
      }
      const doc0 = order0.document;
      const window = documentAccessWindow(doc0, order0.status, Date.now());
      if (!window || !doc0.detectedMimeType) {
        throw new AppError(409, 'DOCUMENT_UNAVAILABLE', 'The document for this order is no longer available');
      }
      const mayInitiate =
        PRINT_INITIATE_FROM.has(order0.status) && doc0.status === DocumentStatus.AVAILABLE && !doc0.printInitiatedAt && !doc0.printedAt;
      // A first print can never hand out a link that outlives its own (about to be created) retention deadline.
      const ttlSeconds = mayInitiate ? Math.min(window.ttlSeconds, Math.floor(retentionMs / 1000)) : window.ttlSeconds;
      // Produce the access URL first: if this throws, nothing has changed and no retention starts.
      const access = await storage.temporaryReadUrl(doc0.objectKey, ttlSeconds, {
        contentType: doc0.detectedMimeType,
        filename: doc0.originalFilename
      });

      const result = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({ where: { id, shopId }, include: { document: true } });
        if (!order) throw orderNotFound();
        if (!PRINT_ACCESS_FROM.has(order.status)) {
          throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Print is not available for this order', { from: order.status, to: OrderStatus.PRINTING });
        }
        const now = new Date();
        let firstPrint = false;
        if (mayInitiate && PRINT_INITIATE_FROM.has(order.status)) {
          // Conditional claim: only ONE concurrent request can start the window; it also re-checks expiry.
          const claimed = await tx.document.updateMany({
            where: {
              id: order.documentId,
              shopId,
              status: DocumentStatus.AVAILABLE,
              printInitiatedAt: null,
              printedAt: null,
              expiresAt: { gt: now }
            },
            data: {
              status: DocumentStatus.PRINTED_RETENTION,
              printInitiatedAt: now,
              deleteAfter: new Date(now.getTime() + retentionMs)
            }
          });
          firstPrint = claimed.count === 1;
        }
        const d = await tx.document.findUniqueOrThrow({ where: { id: order.documentId } });
        // Whether we won the claim or an earlier/concurrent print did, a usable document is PRINTED_RETENTION within its deadline.
        const usable =
          (d.status === DocumentStatus.PRINTED_RETENTION && !!d.deleteAfter && d.deleteAfter > now) ||
          (!mayInitiate && d.status === DocumentStatus.AVAILABLE && !d.printedAt && !d.printInitiatedAt && !!d.expiresAt && d.expiresAt > now);
        if (!usable) throw new AppError(409, 'DOCUMENT_UNAVAILABLE', 'The document for this order is no longer available');

        const start = order.status;
        const path: OrderStatus[] =
          start === OrderStatus.NEW ? [OrderStatus.ACCEPTED, OrderStatus.PRINTING] : start === OrderStatus.ACCEPTED ? [OrderStatus.PRINTING] : [];
        let current: OrderStatus = start;
        for (const to of path) {
          assertRequestedTransition(current, to);
          const moved = await tx.order.updateMany({ where: { id, shopId, status: current }, data: { status: to } });
          if (moved.count !== 1) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Order status changed concurrently', { race: PRINT_NOW_RACE });
          await tx.orderStatusHistory.create({
            data: { orderId: id, fromStatus: current, toStatus: to, reason: 'Print', actorUserId: auth.userId }
          });
          await audit(tx, {
            shopId,
            actorUserId: auth.userId,
            action: 'order.transition',
            targetType: 'order',
            targetId: id,
            metadata: { from: current, to, via: 'print-now' }
          });
          current = to;
        }
        if (firstPrint) {
          await audit(tx, {
            shopId,
            actorUserId: auth.userId,
            action: 'order.printInitiated',
            targetType: 'order',
            targetId: id,
            metadata: { printInitiatedAt: d.printInitiatedAt?.toISOString() ?? null, deleteAfter: d.deleteAfter?.toISOString() ?? null }
          });
        }
        await audit(tx, {
          shopId,
          actorUserId: auth.userId,
          action: 'order.printNow',
          targetType: 'order',
          targetId: id,
          metadata: { from: start, to: current, transitioned: path.length > 0, firstPrint }
        });
        const fresh = await tx.order.findFirstOrThrow({ where: { id, shopId } });
        return { order: fresh, document: d, changed: path.length > 0, firstPrint };
      });
      return { result, access, mimeType: doc0.detectedMimeType };
    };

    let out: Awaited<ReturnType<typeof attempt>>;
    try {
      out = await attempt();
    } catch (e) {
      const raced = e instanceof AppError && (e.details as { race?: string } | undefined)?.race === PRINT_NOW_RACE;
      if (!raced) throw e;
      out = await attempt(); // a concurrent request moved the order: re-evaluate once (now typically PRINTING -> just access)
    }

    const { order, document, changed, firstPrint } = out.result;
    if (changed) {
      events.emit(shopId, 'order.statusChanged', toStatusEvent(order));
      events.emit(shopId, 'order.updated', toStatusEvent(order));
    }
    if (firstPrint) {
      events.emit(shopId, 'document.deletionScheduled', { orderId: order.id, documentId: document.id, deleteAfter: document.deleteAfter });
    }
    await audit(ctx.prisma, { shopId, actorUserId: auth.userId, action: 'document.access', targetType: 'order', targetId: id });
    const deadline = document.deleteAfter ?? document.expiresAt;
    return json({
      order: { id: order.id, orderNumber: order.orderNumber, status: order.status },
      transitioned: changed,
      firstPrint,
      document: {
        status: document.status,
        printInitiatedAt: document.printInitiatedAt ?? document.printedAt,
        deleteAfter: document.deleteAfter
      },
      access: {
        url: out.access.url,
        expiresAt: new Date(Math.min(out.access.expiresAt.getTime(), deadline ? deadline.getTime() : Infinity)),
        contentDisposition: 'inline',
        mimeType: out.mimeType
      }
    });
  });

  /**
   * RETIRED. "Confirm printed" is not a shop-owner concept any more: the browser cannot prove paper came out, so the only
   * signal is "Print initiated" (print-now). Existing PRINTED rows stay readable; nothing can create new ones here.
   */
  app.post('/shop/orders/:id/print-confirmation', { preHandler: limits.printConfirm }, async (request) => {
    shopIdOf(request);
    throw new AppError(410, 'ENDPOINT_RETIRED', 'Print confirmation has been retired. Use Print (print-now); retention starts when Print is initiated.');
  });

  /**
   * Shared by document-access (inline, for printing) and document-download (attachment, explicit "Save File").
   * Same tenant scoping, same deadline rules; neither touches printedAt/deleteAfter or any retention state.
   */
  async function issueDocumentUrl(request: import('fastify').FastifyRequest, disposition: 'inline' | 'attachment') {
    const shopId = shopIdOf(request);
    const auth = authOf(request);
    const { id } = idParam.parse(request.params);
    const order = await prisma.order.findFirst({ where: { id, shopId }, include: { document: true } });
    if (!order) throw orderNotFound();
    const doc = order.document;
    // The earliest applicable deadline bounds access, independent of whether the cleanup worker has run.
    const window = documentAccessWindow(doc, order.status, Date.now());
    if (!window || !doc.detectedMimeType) {
      throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'The document is no longer available');
    }
    const deadline = window.deadline;
    const access = await storage.temporaryReadUrl(doc.objectKey, window.ttlSeconds, {
      contentType: doc.detectedMimeType,
      filename: doc.originalFilename,
      disposition
    });
    // Safe activity record: who/what/when only (never the URL, key, filename or content).
    await audit(ctx.prisma, {
      shopId,
      actorUserId: auth.userId,
      action: disposition === 'attachment' ? 'document.download' : 'document.access',
      targetType: 'order',
      targetId: id
    });
    return {
      url: access.url,
      expiresAt: new Date(Math.min(access.expiresAt.getTime(), deadline.getTime())),
      contentDisposition: disposition,
      mimeType: doc.detectedMimeType,
      fileName: sanitizeFilename(doc.originalFilename)
    };
  }

  app.post('/shop/orders/:id/document-access', { preHandler: limits.documentAccess }, async (request) =>
    json(await issueDocumentUrl(request, 'inline'))
  );

  /** Explicit "Save File": a short-lived ATTACHMENT url for the original document. Never automatic, never extends retention. */
  app.post('/shop/orders/:id/document-download', { preHandler: limits.documentAccess }, async (request) =>
    json(await issueDocumentUrl(request, 'attachment'))
  );
}
