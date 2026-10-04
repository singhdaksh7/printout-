import { DocumentStatus, OrderStatus, Prisma, type Document, type PrismaClient } from '@prisma/client';

/**
 * Document retention / cleanup job.
 *
 * Privacy contract (MASTER_SPEC "Document lifecycle and privacy"):
 *  - printed documents are deleted at/after `deleteAfter` (printedAt + 30 min, never extended),
 *  - unprinted/abandoned documents are deleted at/after `expiresAt` (upload completion + 24 h),
 *    including orphans with no order,
 *  - UPLOADING / FAILED leftovers are swept after their expiry or a stale-upload age,
 *  - a document is marked DELETED only AFTER the object is verified gone,
 *  - orders and their metadata are never deleted.
 *
 * Concurrency approach: every document is processed independently with an idempotent
 * storage delete followed by a conditional `updateMany` (guarded by the expected status).
 * Two workers racing on the same document at worst both delete an already-missing object
 * (harmless); only the worker whose conditional update matches (count === 1) writes the
 * audit row, expires the order and emits events. This needs no schema change, holds no
 * database lock during storage IO, and is retry-safe if a worker dies mid-way (the
 * document stays in its old status and is picked up on the next run).
 */

/** The slice of the Storage interface that cleanup needs (structurally satisfied by `Storage`). */
export interface CleanupStorage {
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export interface CleanupEvents {
  emit(shopId: string, event: string, data: unknown): void;
}

export interface CleanupLogger {
  info?(obj: Record<string, unknown>, msg?: string): void;
  warn?(obj: Record<string, unknown>, msg?: string): void;
  error?(obj: Record<string, unknown>, msg?: string): void;
}

export interface CleanupOptions {
  now?: Date;
  /** Documents fetched per query. Default 100. */
  batchSize?: number;
  /** UPLOADING/FAILED documents older than this (by createdAt) are swept. Default 60 minutes. */
  staleUploadMinutes?: number;
  /** Also re-verify documents already DELETED within the last 24h and remove any object that reappeared. Default false. */
  recheckDeleted?: boolean;
  events?: CleanupEvents;
  log?: CleanupLogger;
}

export type DeletionReason = 'print_retention' | 'unprinted_expiry' | 'stale_upload';

export interface CleanupResult {
  /** Documents examined. */
  scanned: number;
  /** Documents whose object was removed by this run and which are now DELETED. */
  deleted: number;
  /** Documents whose object was already gone (also marked DELETED). */
  alreadyMissing: number;
  /** Documents left untouched for retry because storage failed or verification failed. */
  failed: number;
  /** Documents another worker finished first (informational). */
  raced: number;
  /** Orders moved to EXPIRED because their unprinted document expired. */
  ordersExpired: number;
  errors: { documentId: string; code: string }[];
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_STALE_UPLOAD_MINUTES = 60;
const RECHECK_WINDOW_MS = 24 * 60 * 60_000;
const MAX_ERROR_LENGTH = 200;
/** Order states from which an expired unprinted document expires the order. */
const EXPIRABLE_ORDER_STATUSES: OrderStatus[] = [OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PRINTING];

type DueDocument = Pick<Document, 'id' | 'shopId' | 'objectKey' | 'status' | 'printedAt' | 'deletedAt'>;

class VerificationError extends Error {
  readonly code = 'STORAGE_VERIFY_FAILED';
}

/** Maps any thrown value to a short, safe code (never a path, key, credential or raw message). */
export function safeErrorCode(error: unknown): string {
  if (error instanceof VerificationError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return `STORAGE_${code.toUpperCase()}`.slice(0, MAX_ERROR_LENGTH);
  return 'STORAGE_DELETE_FAILED';
}

function reasonFor(document: DueDocument): DeletionReason {
  if (document.status === DocumentStatus.PRINTED_RETENTION) return 'print_retention';
  if (document.status === DocumentStatus.AVAILABLE) return 'unprinted_expiry';
  return 'stale_upload';
}

function dueWhere(now: Date, staleBefore: Date): Prisma.DocumentWhereInput {
  return {
    OR: [
      { status: DocumentStatus.PRINTED_RETENTION, deleteAfter: { lte: now } },
      { status: DocumentStatus.AVAILABLE, expiresAt: { lte: now } },
      {
        status: { in: [DocumentStatus.UPLOADING, DocumentStatus.FAILED] },
        OR: [{ expiresAt: { lte: now } }, { createdAt: { lte: staleBefore } }]
      }
    ]
  };
}

export async function cleanupExpiredDocuments(
  prisma: PrismaClient,
  storage: CleanupStorage,
  opts: CleanupOptions = {}
): Promise<CleanupResult> {
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const staleBefore = new Date(now.getTime() - (opts.staleUploadMinutes ?? DEFAULT_STALE_UPLOAD_MINUTES) * 60_000);
  const result: CleanupResult = { scanned: 0, deleted: 0, alreadyMissing: 0, failed: 0, raced: 0, ordersExpired: 0, errors: [] };

  // Keyset pagination by id: a document that fails stays "due" but is never re-fetched within this run.
  let cursor: string | undefined;
  for (;;) {
    const batch: DueDocument[] = await prisma.document.findMany({
      where: { AND: [dueWhere(now, staleBefore), cursor ? { id: { gt: cursor } } : {}] },
      select: { id: true, shopId: true, objectKey: true, status: true, printedAt: true, deletedAt: true },
      orderBy: { id: 'asc' },
      take: batchSize
    });
    if (batch.length === 0) break;
    for (const document of batch) await processDocument(prisma, storage, document, now, opts, result);
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < batchSize) break;
  }

  if (opts.recheckDeleted) await recheckDeleted(prisma, storage, now, batchSize, opts, result);

  if (result.scanned > 0) {
    opts.log?.info?.(
      { scanned: result.scanned, deleted: result.deleted, alreadyMissing: result.alreadyMissing, failed: result.failed, raced: result.raced, ordersExpired: result.ordersExpired },
      'document cleanup finished'
    );
  }
  return result;
}

async function processDocument(
  prisma: PrismaClient,
  storage: CleanupStorage,
  document: DueDocument,
  now: Date,
  opts: CleanupOptions,
  result: CleanupResult
): Promise<void> {
  result.scanned += 1;
  let existed: boolean;
  try {
    existed = await deleteAndVerify(storage, document.objectKey);
  } catch (error) {
    await recordFailure(prisma, document.id, error, opts, result);
    return;
  }

  try {
    const marked = await markDeleted(prisma, document, now, opts);
    if (!marked.won) {
      result.raced += 1;
      return;
    }
    if (existed) result.deleted += 1;
    else result.alreadyMissing += 1;
    if (marked.orderExpired) result.ordersExpired += 1;
  } catch (error) {
    // Object is gone but the DB write failed: leave status unchanged so the next run retries (delete is idempotent).
    result.failed += 1;
    result.errors.push({ documentId: document.id, code: 'DB_UPDATE_FAILED' });
    opts.log?.error?.({ documentId: document.id, code: 'DB_UPDATE_FAILED', err: safeErrorCode(error) }, 'document cleanup db update failed');
  }
}

/** Deletes the object and proves it is gone. Returns whether the object existed before this call. */
async function deleteAndVerify(storage: CleanupStorage, key: string): Promise<boolean> {
  const existed = await storage.exists(key);
  await storage.delete(key);
  if (await storage.exists(key)) throw new VerificationError('Object still present after delete');
  return existed;
}

async function recordFailure(prisma: PrismaClient, documentId: string, error: unknown, opts: CleanupOptions, result: CleanupResult) {
  const code = safeErrorCode(error);
  result.failed += 1;
  result.errors.push({ documentId, code });
  opts.log?.warn?.({ documentId, code }, 'document deletion failed; will retry');
  try {
    // Status is deliberately left untouched so the document remains due.
    await prisma.document.updateMany({
      where: { id: documentId, status: { not: DocumentStatus.DELETED } },
      data: { deletionError: code.slice(0, MAX_ERROR_LENGTH) }
    });
  } catch {
    /* recording the error is best effort */
  }
}

/**
 * Atomically (one transaction) flips the document to DELETED, expires the order when
 * the document was never printed, and writes history + audit rows. The conditional
 * updateMany makes the whole block a no-op for the losing worker.
 */
async function markDeleted(prisma: PrismaClient, document: DueDocument, now: Date, opts: CleanupOptions) {
  const reason = reasonFor(document);
  const outcome = await prisma.$transaction(async (tx) => {
    const updated = await tx.document.updateMany({
      where: { id: document.id, status: document.status },
      data: { status: DocumentStatus.DELETED, deletedAt: now, deletionError: null }
    });
    if (updated.count !== 1) return { won: false as const };

    await tx.auditLog.create({
      data: { shopId: document.shopId, action: 'document.deleted', targetType: 'document', targetId: document.id, metadata: { reason } }
    });

    let expired: { id: string; status: OrderStatus; updatedAt: Date } | null = null;
    if (reason !== 'print_retention') {
      const order = await tx.order.findUnique({ where: { documentId: document.id }, select: { id: true, shopId: true, status: true } });
      if (order && EXPIRABLE_ORDER_STATUSES.includes(order.status)) {
        // BE's lifecycle table has no PRINTING -> EXPIRED edge; the worker updates directly (spec decision reported to lead).
        const moved = await tx.order.updateMany({ where: { id: order.id, status: order.status }, data: { status: OrderStatus.EXPIRED } });
        if (moved.count === 1) {
          await tx.orderStatusHistory.create({
            data: { orderId: order.id, fromStatus: order.status, toStatus: OrderStatus.EXPIRED, actorUserId: null, reason: 'document_expired' }
          });
          await tx.auditLog.create({
            data: { shopId: order.shopId, action: 'order.expired', targetType: 'order', targetId: order.id, metadata: { reason: 'document_expired' } }
          });
          const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, status: true, updatedAt: true } });
          expired = fresh;
        }
      }
    }
    return { won: true as const, expired };
  });

  if (!outcome.won) return { won: false as const, orderExpired: false };

  // Events are best effort and only reach SSE clients in this process (the worker is a separate process).
  emitSafe(opts, document.shopId, 'document.deleted', { documentId: document.id, reason });
  if (outcome.expired) emitSafe(opts, document.shopId, 'order.statusChanged', outcome.expired);
  return { won: true as const, orderExpired: outcome.expired !== null };
}

function emitSafe(opts: CleanupOptions, shopId: string, event: string, data: unknown) {
  try {
    opts.events?.emit(shopId, event, data);
  } catch {
    /* never let a subscriber break cleanup */
  }
}

/** Optional safety net: a DELETED document whose object reappeared (e.g. restored backup, late upload write). */
async function recheckDeleted(
  prisma: PrismaClient,
  storage: CleanupStorage,
  now: Date,
  batchSize: number,
  opts: CleanupOptions,
  result: CleanupResult
) {
  const since = new Date(now.getTime() - RECHECK_WINDOW_MS);
  const recent = await prisma.document.findMany({
    where: { status: DocumentStatus.DELETED, deletedAt: { gte: since } },
    select: { id: true, objectKey: true },
    orderBy: { id: 'asc' },
    take: batchSize
  });
  for (const document of recent) {
    try {
      if (!(await storage.exists(document.objectKey))) continue;
      result.scanned += 1;
      await deleteAndVerify(storage, document.objectKey);
      result.deleted += 1;
      opts.log?.warn?.({ documentId: document.id }, 'removed object of an already deleted document');
    } catch (error) {
      result.failed += 1;
      result.errors.push({ documentId: document.id, code: safeErrorCode(error) });
    }
  }
}
