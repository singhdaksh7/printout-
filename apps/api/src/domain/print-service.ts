import { DocumentStatus, OrderStatus } from '@prisma/client';
import { AppError, orderNotFound } from '../errors.js';
import { audit, type AppContext } from '../routes/context.js';
import { sanitizeFilename } from '../storage/filename.js';
import { documentAccessWindow } from './access.js';
import { assertRequestedTransition } from './lifecycle.js';
import { toStatusEvent } from './order-serializers.js';

/**
 * THE print engine. Browser (owner session) and device (Bearer) routes both call it, so retention semantics exist once:
 * the FIRST successful Print atomically claims the document (conditional update) and sets printInitiatedAt = now,
 * deleteAfter = now + PRINT_RETENTION_MINUTES; reprint / save / retries never move either timestamp.
 */
export type PrintActor = { type: 'SHOP_OWNER'; userId: string } | { type: 'SHOP_DEVICE'; deviceId: string };

/** Statuses from which the FIRST Print may start retention: it ends in PRINTING and never goes further. */
const PRINT_INITIATE_FROM: ReadonlySet<OrderStatus> = new Set([OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PRINTING]);
/** Statuses that may (re)open the document for printing while it is still retained (includes legacy confirmed orders). */
const PRINT_ACCESS_FROM: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PRINTING, OrderStatus.PRINTED, OrderStatus.READY, OrderStatus.COLLECTED
]);
const PRINT_NOW_RACE = 'PRINT_NOW_RACE';

const actorAudit = (actor: PrintActor) =>
  actor.type === 'SHOP_OWNER'
    ? { actorUserId: actor.userId, actorType: 'SHOP_OWNER' as const, actorDeviceId: null }
    : { actorUserId: null, actorType: 'SHOP_DEVICE' as const, actorDeviceId: actor.deviceId };
const actorHistory = (actor: PrintActor) =>
  actor.type === 'SHOP_OWNER' ? { actorUserId: actor.userId } : { actorDeviceId: actor.deviceId };

export interface InitiatePrintInput {
  actor: PrintActor;
  shopId: string;
  orderId: string;
  /** Validated by the route (uuid); retries are naturally idempotent (conditional claim). */
  clientRequestId: string;
}

export interface InitiatePrintResult {
  order: { id: string; orderNumber: string; status: OrderStatus };
  transitioned: boolean;
  firstPrint: boolean;
  document: { status: DocumentStatus; printInitiatedAt: Date | null; deleteAfter: Date | null };
  access: { url: string; expiresAt: Date; contentDisposition: 'inline'; mimeType: string };
}

export async function initiatePrint(ctx: AppContext, input: InitiatePrintInput): Promise<InitiatePrintResult> {
  const { prisma, config, storage, events } = ctx;
  const { actor, shopId, orderId: id } = input;
  const retentionMs = config.PRINT_RETENTION_MINUTES * 60_000;
  const who = actorAudit(actor);

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
          data: { orderId: id, fromStatus: current, toStatus: to, reason: 'Print', ...actorHistory(actor) }
        });
        await audit(tx, {
          shopId,
          ...who,
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
          ...who,
          action: 'order.printInitiated',
          targetType: 'order',
          targetId: id,
          metadata: { printInitiatedAt: d.printInitiatedAt?.toISOString() ?? null, deleteAfter: d.deleteAfter?.toISOString() ?? null }
        });
      }
      await audit(tx, {
        shopId,
        ...who,
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
  await audit(prisma, { shopId, ...who, action: 'document.access', targetType: 'order', targetId: id });
  const deadline = document.deleteAfter ?? document.expiresAt;
  return {
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
  };
}

export interface IssueDocumentAccessInput {
  actor: PrintActor;
  shopId: string;
  orderId: string;
  disposition: 'inline' | 'attachment';
  /**
   * Reprint must follow a Print: when true, an inline request for a document whose Print was never initiated is refused
   * (409) and no retention is started. Defaults to true for devices; the browser document-access route keeps its Phase 1
   * behaviour by passing false.
   */
  requirePrintInitiated?: boolean;
}

export interface DocumentAccessResult {
  url: string;
  expiresAt: Date;
  contentDisposition: 'inline' | 'attachment';
  mimeType: string;
  fileName: string;
}

/** Reprint (inline) / Save File (attachment). Never touches printInitiatedAt, deleteAfter or any status. */
export async function issueDocumentAccess(ctx: AppContext, input: IssueDocumentAccessInput): Promise<DocumentAccessResult> {
  const { prisma, storage } = ctx;
  const { actor, shopId, orderId: id, disposition } = input;
  const requirePrinted = input.requirePrintInitiated ?? actor.type === 'SHOP_DEVICE';
  const order = await prisma.order.findFirst({ where: { id, shopId }, include: { document: true } });
  if (!order) throw orderNotFound();
  const doc = order.document;
  // The earliest applicable deadline bounds access, independent of whether the cleanup worker has run.
  const window = documentAccessWindow(doc, order.status, Date.now());
  if (!window || !doc.detectedMimeType) {
    throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'The document is no longer available');
  }
  if (requirePrinted && disposition === 'inline' && !doc.printInitiatedAt && !doc.printedAt) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Print the order first');
  }
  const access = await storage.temporaryReadUrl(doc.objectKey, window.ttlSeconds, {
    contentType: doc.detectedMimeType,
    filename: doc.originalFilename,
    disposition
  });
  // Safe activity record: who/what/when only (never the URL, key, filename or content).
  await audit(prisma, {
    shopId,
    ...actorAudit(actor),
    action: disposition === 'attachment' ? 'document.download' : 'document.access',
    targetType: 'order',
    targetId: id
  });
  return {
    url: access.url,
    expiresAt: new Date(Math.min(access.expiresAt.getTime(), window.deadline.getTime())),
    contentDisposition: disposition,
    mimeType: doc.detectedMimeType,
    fileName: sanitizeFilename(doc.originalFilename)
  };
}
