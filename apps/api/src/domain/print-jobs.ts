import { randomUUID } from 'node:crypto';
import { DevicePrintJobStatus as S, type DevicePrintJob, type DevicePrinter, type Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../errors.js';
import { audit, isUniqueViolation, type AppContext } from '../routes/context.js';
import { documentAccessWindow } from './access.js';
import { printOptionsSchema } from './pricing.js';
import { initiatePrint } from './print-service.js';

/**
 * Windows print dispatch (DevicePrintJob).
 *
 * THERE IS NO "PRINTED" STATE. The spooler knows about its queue, not about paper, and the platform has no hardware
 * acknowledgement. PRINT_INITIATED = "the spooler accepted the job and began processing it". The ORDER only becomes PRINTED
 * through the shopkeeper's manual confirmation (existing flow); nothing here ever sets it.
 *
 * Safety invariant (printing is a physical side effect): a job that MAY have reached the spooler is never re-queued by the
 * server and never re-submitted by the agent. Ambiguity ends in NEEDS_RECONCILIATION and a human decides.
 *   - SUBMITTING is a write-ahead intent the agent reports BEFORE it touches the spooler.
 *   - Lease expiry in CLAIMED/DOWNLOADING (nothing could have been submitted) => QUEUED again.
 *   - Lease expiry in SUBMITTING/SUBMITTED_TO_SPOOLER => NEEDS_RECONCILIATION.
 */
export const LEASE_SECONDS = 120;
export const MAX_ATTEMPTS = 5;
export const DOWNLOAD_URL_MAX_SECONDS = 120;

/** Statuses in which a job exists "in flight" and blocks another job for the same order. */
export const BLOCKING_STATUSES: S[] = [
  S.QUEUED, S.CLAIMED, S.DOWNLOADING, S.SUBMITTING, S.SUBMITTED_TO_SPOOLER, S.CANCEL_REQUESTED, S.NEEDS_RECONCILIATION
];
/** Statuses owned by an agent lease (expire if the agent goes silent). */
const LEASED: S[] = [S.CLAIMED, S.DOWNLOADING, S.SUBMITTING, S.SUBMITTED_TO_SPOOLER, S.CANCEL_REQUESTED];
const SUBMISSION_STARTED: ReadonlySet<S> = new Set([S.SUBMITTING, S.SUBMITTED_TO_SPOOLER, S.PRINT_INITIATED]);

/** Agent-driven edges. Same-status repeats are handled separately (idempotent lease renewal). */
const AGENT_EDGES: Record<S, S[]> = {
  QUEUED: [],
  CLAIMED: [S.DOWNLOADING, S.FAILED],
  DOWNLOADING: [S.SUBMITTING, S.FAILED],
  SUBMITTING: [S.SUBMITTED_TO_SPOOLER, S.PRINT_INITIATED, S.FAILED, S.NEEDS_RECONCILIATION],
  SUBMITTED_TO_SPOOLER: [S.PRINT_INITIATED, S.FAILED, S.NEEDS_RECONCILIATION],
  PRINT_INITIATED: [S.FAILED, S.NEEDS_RECONCILIATION],
  CANCEL_REQUESTED: [S.CANCELED, S.FAILED, S.PRINT_INITIATED, S.NEEDS_RECONCILIATION],
  CANCELED: [],
  FAILED: [],
  // Evidence only: the original lease holder found the job in the spooler after a crash.
  NEEDS_RECONCILIATION: [S.SUBMITTED_TO_SPOOLER, S.PRINT_INITIATED]
};

export type AgentReportStatus = Exclude<S, 'QUEUED' | 'CLAIMED' | 'CANCEL_REQUESTED'>;

const errorCodeRe = /^[A-Z0-9_]{1,40}$/;
/** Agent-supplied text is stored/shown to the shop: bounded, control characters removed, never document content. */
export const safeText = (v: string | undefined | null, max = 300): string | null => {
  if (!v) return null;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null;
};

export interface DeviceRef { deviceId: string; shopId: string }

const conflict = (code: 'LEASE_MISMATCH' | 'INVALID_STATUS_TRANSITION' | 'JOB_CANCEL_REQUESTED' | 'ACTIVE_PRINT_JOB_EXISTS' | 'DUPLICATE_RISK_NOT_ACKNOWLEDGED' | 'PRINTER_NOT_AUTHORIZED' | 'PRINTER_UNAVAILABLE' | 'PRINTER_UNSUPPORTED_OPTIONS', message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const printJobNotFound = () => new AppError(404, 'PRINT_JOB_NOT_FOUND', 'Print job not found');

type Db = PrismaClient | Prisma.TransactionClient;

/** Result of writes that must be announced after commit. */
export interface JobChange { id: string; orderId: string; shopId: string; status: S }
const change = (j: Pick<DevicePrintJob, 'id' | 'orderId' | 'shopId' | 'status'>): JobChange => ({ id: j.id, orderId: j.orderId, shopId: j.shopId, status: j.status });

export function announce(ctx: AppContext, changes: JobChange[]): void {
  for (const c of changes) ctx.events.emit(c.shopId, 'printJob.updated', { id: c.id, orderId: c.orderId, status: c.status });
}

async function lockJob(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "DevicePrintJob" WHERE "id" = ${id} FOR UPDATE`;
}

/**
 * Applies the lease-expiry rules to expired jobs (scoped to one device, one shop, or one job). Idempotent; safe to call from
 * any read/claim path. Returns what changed so the caller can announce it after commit.
 */
export async function recoverExpiredLeases(tx: Db, scope: { deviceId?: string; shopId?: string; jobId?: string }, now = new Date()): Promise<JobChange[]> {
  const rows = await tx.devicePrintJob.findMany({
    where: {
      status: { in: LEASED },
      leaseExpiresAt: { lt: now },
      ...(scope.deviceId ? { deviceId: scope.deviceId } : {}),
      ...(scope.shopId ? { shopId: scope.shopId } : {}),
      ...(scope.jobId ? { id: scope.jobId } : {})
    },
    take: 50
  });
  const out: JobChange[] = [];
  for (const j of rows) {
    let data: Prisma.DevicePrintJobUpdateManyMutationInput & { status: S };
    if (j.status === S.CLAIMED || j.status === S.DOWNLOADING) {
      data = j.attempt >= MAX_ATTEMPTS
        ? { status: S.FAILED, errorCode: 'TOO_MANY_ATTEMPTS', errorMessage: 'The print agent did not complete this job', leaseExpiresAt: null }
        : { status: S.QUEUED, leaseExpiresAt: null, errorCode: 'LEASE_EXPIRED', errorMessage: 'The print agent went silent before submitting; the job was re-queued' };
    } else if (j.status === S.CANCEL_REQUESTED && (j.statusBeforeCancel === S.CLAIMED || j.statusBeforeCancel === S.DOWNLOADING)) {
      // Nothing could have reached the spooler: the cancel is effectively confirmed.
      data = { status: S.CANCELED, leaseExpiresAt: null };
    } else {
      data = {
        status: S.NEEDS_RECONCILIATION,
        leaseExpiresAt: null,
        errorCode: 'LEASE_EXPIRED_AFTER_SUBMIT',
        errorMessage: 'The print agent went silent after the job may have reached the printer. Check the printer before printing again.'
      };
    }
    // Conditional on the exact observed status+expiry: a concurrent progress call wins and nothing is overwritten.
    const res = await tx.devicePrintJob.updateMany({
      where: { id: j.id, status: j.status, leaseExpiresAt: j.leaseExpiresAt },
      data: { ...data, ...(data.status === S.QUEUED ? { leaseId: null } : {}) }
    });
    if (res.count === 1) {
      out.push(change({ ...j, status: data.status }));
      await audit(tx, {
        shopId: j.shopId, actorUserId: null, actorType: 'SYSTEM', action: 'printJob.leaseExpired',
        targetType: 'DevicePrintJob', targetId: j.id, metadata: { from: j.status, to: data.status }
      });
    }
  }
  return out;
}

/* ------------------------------ printers ------------------------------ */

export interface ReportedPrinter {
  name: string;
  driverName?: string | undefined;
  connectivity: 'ONLINE' | 'OFFLINE' | 'ERROR' | 'UNKNOWN';
  statusDetail?: string | undefined;
  supportsColour: boolean;
  supportsDuplex: boolean;
  paperSizes?: string[] | undefined;
}

/** Replaces the device's printer snapshot. Never touches authorized/isDefault of existing rows (those are the owner's decisions). */
export async function reportPrinters(prisma: PrismaClient, me: DeviceRef, printers: ReportedPrinter[]) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'device-printers:' + me.deviceId}))`;
    const names = printers.map((p) => p.name);
    for (const p of printers) {
      const data = {
        driverName: p.driverName ?? null,
        connectivity: p.connectivity,
        statusDetail: safeText(p.statusDetail, 200),
        supportsColour: p.supportsColour,
        supportsDuplex: p.supportsDuplex,
        paperSizes: (p.paperSizes ?? []) as Prisma.InputJsonValue,
        present: true,
        lastReportedAt: now
      };
      await tx.devicePrinter.upsert({
        where: { deviceId_name: { deviceId: me.deviceId, name: p.name } },
        create: { shopId: me.shopId, deviceId: me.deviceId, name: p.name, ...data },
        update: data
      });
    }
    // Printers no longer reported are marked absent (kept, so the owner's authorization survives a driver reinstall).
    await tx.devicePrinter.updateMany({
      where: { deviceId: me.deviceId, shopId: me.shopId, present: true, name: { notIn: names } },
      data: { present: false, connectivity: 'OFFLINE', lastReportedAt: now }
    });
  });
  return listDevicePrinters(prisma, me.shopId, me.deviceId);
}

export const printerView = (p: DevicePrinter) => ({
  id: p.id,
  deviceId: p.deviceId,
  name: p.name,
  driverName: p.driverName,
  connectivity: p.connectivity,
  statusDetail: p.statusDetail,
  supportsColour: p.supportsColour,
  supportsDuplex: p.supportsDuplex,
  paperSizes: Array.isArray(p.paperSizes) ? (p.paperSizes as string[]) : [],
  present: p.present,
  authorized: p.authorized,
  isDefault: p.isDefault,
  lastReportedAt: p.lastReportedAt
});

export async function listDevicePrinters(db: Db, shopId: string, deviceId?: string) {
  const rows = await db.devicePrinter.findMany({
    where: { shopId, ...(deviceId ? { deviceId } : {}) },
    orderBy: [{ name: 'asc' }, { id: 'asc' }]
  });
  return rows.map(printerView);
}

/** Owner decision. Authorizing is required before any job can target the printer; one default per shop. */
export async function updatePrinterSettings(
  prisma: PrismaClient,
  actor: { shopId: string; userId: string },
  deviceId: string,
  printerId: string,
  patch: { authorized?: boolean | undefined; isDefault?: boolean | undefined }
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'shop-default-printer:' + actor.shopId}))`;
    const printer = await tx.devicePrinter.findFirst({
      where: { id: printerId, deviceId, shopId: actor.shopId, device: { platform: 'WINDOWS', status: 'ACTIVE' } }
    });
    if (!printer) throw new AppError(404, 'NOT_FOUND', 'Printer not found');
    const authorized = patch.authorized ?? printer.authorized;
    let isDefault = patch.isDefault ?? printer.isDefault;
    if (patch.isDefault === true && !authorized) throw new AppError(409, 'PRINTER_NOT_AUTHORIZED', 'Authorize the printer before making it the default');
    if (!authorized) isDefault = false;
    if (isDefault && !printer.present) throw conflict('PRINTER_UNAVAILABLE', 'This printer is no longer reported by the computer');
    if (isDefault) await tx.devicePrinter.updateMany({ where: { shopId: actor.shopId, isDefault: true, id: { not: printerId } }, data: { isDefault: false } });
    const updated = await tx.devicePrinter.update({ where: { id: printerId }, data: { authorized, isDefault } });
    await audit(tx, {
      shopId: actor.shopId, actorUserId: actor.userId, actorType: 'SHOP_OWNER', action: 'devicePrinter.updated',
      targetType: 'DevicePrinter', targetId: printerId, metadata: { authorized, isDefault }
    });
    return printerView(updated);
  });
}

/* ------------------------------ enqueue (shop) ------------------------------ */

export interface JobOptions {
  copies: number;
  colourMode: 'bw' | 'colour';
  sides: 'single' | 'duplex';
  paperSize: string;
  pageSelection: { mode: 'all' } | { mode: 'ranges'; ranges: Array<{ from: number; to: number }> };
}

/** Re-validates the stored order snapshot with the same schema the order was created with; unknown shapes fail closed. */
const optionsOf = (snapshot: unknown): JobOptions => {
  const parsed = printOptionsSchema.safeParse(snapshot);
  if (!parsed.success) throw new AppError(409, 'VALIDATION_ERROR', 'This order has print options that cannot be sent to a printer');
  return parsed.data as JobOptions;
};

export const jobView = (j: DevicePrintJob & { printer?: Pick<DevicePrinter, 'id' | 'name' | 'deviceId'> | null }) => ({
  id: j.id,
  orderId: j.orderId,
  deviceId: j.deviceId,
  printerId: j.printerId,
  printerName: j.printer?.name ?? null,
  status: j.status,
  attempt: j.attempt,
  options: j.options as unknown as JobOptions,
  spoolerJobId: j.spoolerJobId,
  spoolerState: j.spoolerState,
  errorCode: j.errorCode,
  errorMessage: j.errorMessage,
  /** True when a retry could duplicate pages (the job may have reached the spooler). */
  duplicateRisk: j.submittingAt !== null,
  needsReconciliation: j.status === S.NEEDS_RECONCILIATION,
  resolution: j.resolution,
  printInitiatedAt: j.printInitiatedAt,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt
});

export interface EnqueueInput {
  shopId: string;
  userId: string;
  orderId: string;
  clientRequestId: string;
  printerId?: string | undefined;
  /** Print again although an earlier job already reached PRINT_INITIATED. */
  reprint?: boolean | undefined;
  /** Required when the last job for this order may already have reached the spooler (FAILED after SUBMITTING). */
  acknowledgeDuplicateRisk?: boolean | undefined;
}

async function resolvePrinter(db: Db, shopId: string, printerId: string | undefined, options: JobOptions) {
  const printer = printerId
    ? await db.devicePrinter.findFirst({ where: { id: printerId, shopId }, include: { device: true } })
    : await db.devicePrinter.findFirst({ where: { shopId, isDefault: true, authorized: true }, include: { device: true } });
  if (!printer) {
    throw printerId
      ? new AppError(404, 'NOT_FOUND', 'Printer not found')
      : conflict('PRINTER_NOT_AUTHORIZED', 'No default printer is set. Authorize a printer on the Devices page first.');
  }
  if (!printer.authorized) throw conflict('PRINTER_NOT_AUTHORIZED', 'This printer has not been authorized for printing');
  if (printer.device.platform !== 'WINDOWS' || printer.device.status !== 'ACTIVE') throw conflict('PRINTER_UNAVAILABLE', 'The computer for this printer is disconnected');
  if (!printer.present) throw conflict('PRINTER_UNAVAILABLE', 'This printer is no longer reported by the computer');
  if (options.colourMode === 'colour' && !printer.supportsColour) throw conflict('PRINTER_UNSUPPORTED_OPTIONS', 'This printer does not support colour printing');
  if (options.sides === 'duplex' && !printer.supportsDuplex) throw conflict('PRINTER_UNSUPPORTED_OPTIONS', 'This printer does not support two-sided printing');
  return printer;
}

/**
 * Validates the target, starts retention through the ONE print engine (initiatePrint: order -> PRINTING, window starts once),
 * then inserts the job under a per-order lock. Safe to repeat with the same clientRequestId.
 */
export async function enqueuePrintJob(ctx: AppContext, input: EnqueueInput) {
  const { prisma } = ctx;
  const { shopId, orderId } = input;
  const existing = await prisma.devicePrintJob.findUnique({
    where: { shopId_clientRequestId: { shopId, clientRequestId: input.clientRequestId } },
    include: { printer: true }
  });
  if (existing) {
    if (existing.orderId !== orderId) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This request id was used for another order');
    return { job: jobView(existing), created: false };
  }
  const order = await prisma.order.findFirst({ where: { id: orderId, shopId }, select: { id: true, documentId: true, printOptionsSnapshot: true } });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  const options = optionsOf(order.printOptionsSnapshot);
  const printer = await resolvePrinter(prisma, shopId, input.printerId, options);

  await initiatePrint(ctx, { actor: { type: 'SHOP_OWNER', userId: input.userId }, shopId, orderId, clientRequestId: input.clientRequestId });

  try {
    const job = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'print-job-order:' + orderId}))`;
      // Re-validate under the lock: the printer may have been de-authorized while initiatePrint ran.
      const fresh = await resolvePrinter(tx, shopId, printer.id, options);
      const latest = await tx.devicePrintJob.findMany({ where: { shopId, orderId }, orderBy: { createdAt: 'desc' }, take: 10 });
      const blocking = latest.find((j) => BLOCKING_STATUSES.includes(j.status));
      if (blocking) throw conflict('ACTIVE_PRINT_JOB_EXISTS', 'This order already has a print job in progress', { jobId: blocking.id, status: blocking.status });
      const last = latest[0];
      if (last?.status === S.PRINT_INITIATED && !input.reprint) {
        throw conflict('ACTIVE_PRINT_JOB_EXISTS', 'This order was already sent to the printer. Use Print again to confirm.', { jobId: last.id, status: last.status });
      }
      if (last && last.submittingAt && last.status === S.FAILED && !input.acknowledgeDuplicateRisk) {
        throw conflict('DUPLICATE_RISK_NOT_ACKNOWLEDGED', 'The previous attempt may already have printed. Check the printer, then confirm.', { jobId: last.id });
      }
      const created = await tx.devicePrintJob.create({
        data: {
          shopId, orderId, documentId: order.documentId, deviceId: fresh.deviceId, printerId: fresh.id,
          clientRequestId: input.clientRequestId, options: options as unknown as Prisma.InputJsonValue, requestedByUserId: input.userId
        },
        include: { printer: true }
      });
      await audit(tx, {
        shopId, actorUserId: input.userId, actorType: 'SHOP_OWNER', action: 'printJob.queued',
        targetType: 'DevicePrintJob', targetId: created.id, metadata: { orderId, printerId: fresh.id, reprint: !!input.reprint }
      });
      return created;
    });
    announce(ctx, [change(job)]);
    return { job: jobView(job), created: true };
  } catch (e) {
    if (isUniqueViolation(e, 'clientRequestId')) {
      const again = await prisma.devicePrintJob.findUnique({
        where: { shopId_clientRequestId: { shopId, clientRequestId: input.clientRequestId } }, include: { printer: true }
      });
      if (again) return { job: jobView(again), created: false };
    }
    throw e;
  }
}

export async function listShopJobs(ctx: AppContext, shopId: string, query: { orderId?: string | undefined }) {
  const changes = await recoverExpiredLeases(ctx.prisma, { shopId });
  announce(ctx, changes);
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await ctx.prisma.devicePrintJob.findMany({
    where: { shopId, ...(query.orderId ? { orderId: query.orderId } : { OR: [{ status: { in: BLOCKING_STATUSES } }, { updatedAt: { gte: since } }] }) },
    include: { printer: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100
  });
  return rows.map(jobView);
}

/* ------------------------------ shop actions ------------------------------ */

async function ownedJob(tx: Db, shopId: string, id: string) {
  const job = await tx.devicePrintJob.findFirst({ where: { id, shopId } });
  if (!job) throw printJobNotFound();
  return job;
}

export async function cancelJob(ctx: AppContext, actor: { shopId: string; userId: string }, id: string) {
  const out = await ctx.prisma.$transaction(async (tx) => {
    await lockJob(tx, id);
    const recovered = await recoverExpiredLeases(tx, { jobId: id });
    const job = await ownedJob(tx, actor.shopId, id);
    let next: Prisma.DevicePrintJobUpdateInput | null = null;
    if (job.status === S.QUEUED) next = { status: S.CANCELED, cancelRequestedAt: new Date() }; // never claimed => truly canceled
    else if (job.status === S.CANCEL_REQUESTED || job.status === S.CANCELED) next = null; // idempotent
    else if (job.status === S.NEEDS_RECONCILIATION) throw conflict('INVALID_STATUS_TRANSITION', 'Resolve this job with Reconcile instead', { from: job.status });
    else if (BLOCKING_STATUSES.includes(job.status) || job.status === S.PRINT_INITIATED) {
      // The agent must answer within a lease; silence after submission becomes NEEDS_RECONCILIATION (see recoverExpiredLeases).
      next = { status: S.CANCEL_REQUESTED, statusBeforeCancel: job.status, cancelRequestedAt: new Date(), leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000) };
    } else throw conflict('INVALID_STATUS_TRANSITION', `A ${job.status.toLowerCase()} job cannot be canceled`, { from: job.status });
    if (next) {
      await tx.devicePrintJob.update({ where: { id }, data: next });
      await audit(tx, { shopId: actor.shopId, actorUserId: actor.userId, actorType: 'SHOP_OWNER', action: 'printJob.cancelRequested', targetType: 'DevicePrintJob', targetId: id, metadata: { from: job.status } });
    }
    return { job: await tx.devicePrintJob.findUniqueOrThrow({ where: { id }, include: { printer: true } }), recovered };
  });
  announce(ctx, [...out.recovered, change(out.job)]);
  return jobView(out.job);
}

/** Retry of a FAILED job as a NEW job (history is kept). Needs acknowledgement when the job may already have reached the spooler. */
export async function retryJob(ctx: AppContext, actor: { shopId: string; userId: string }, id: string, input: { clientRequestId: string; acknowledgeDuplicateRisk?: boolean | undefined }) {
  const job = await ownedJob(ctx.prisma, actor.shopId, id);
  if (job.status !== S.FAILED) throw conflict('INVALID_STATUS_TRANSITION', 'Only a failed job can be retried', { from: job.status });
  if (job.submittingAt && !input.acknowledgeDuplicateRisk) {
    throw conflict('DUPLICATE_RISK_NOT_ACKNOWLEDGED', 'This job may already have reached the printer. Check the printer, then confirm.', { jobId: id });
  }
  return enqueuePrintJob(ctx, {
    shopId: actor.shopId, userId: actor.userId, orderId: job.orderId, clientRequestId: input.clientRequestId,
    printerId: job.printerId, acknowledgeDuplicateRisk: true, reprint: true
  });
}

export type Resolution = 'PRINTED' | 'NOT_PRINTED_REQUEUE' | 'NOT_PRINTED_GIVE_UP';

/** Manual reconciliation of an ambiguous job: the shopkeeper looked at the printer and says what happened. */
export async function reconcileJob(ctx: AppContext, actor: { shopId: string; userId: string }, id: string, input: { resolution: Resolution; clientRequestId?: string | undefined }) {
  // Validate BEFORE writing: a refused request must not leave the job half-resolved.
  if (input.resolution === 'NOT_PRINTED_REQUEUE' && !input.clientRequestId) throw new AppError(400, 'VALIDATION_ERROR', 'clientRequestId is required to print again');
  const out = await ctx.prisma.$transaction(async (tx) => {
    await lockJob(tx, id);
    const job = await ownedJob(tx, actor.shopId, id);
    if (job.status !== S.NEEDS_RECONCILIATION) throw conflict('INVALID_STATUS_TRANSITION', 'Only a job needing reconciliation can be reconciled', { from: job.status });
    const data: Prisma.DevicePrintJobUpdateInput =
      input.resolution === 'PRINTED'
        ? { status: S.PRINT_INITIATED, printInitiatedAt: job.printInitiatedAt ?? new Date(), resolution: 'MANUALLY_CONFIRMED_PRINTED' }
        : input.resolution === 'NOT_PRINTED_REQUEUE'
          ? { status: S.FAILED, resolution: 'MANUALLY_CONFIRMED_NOT_PRINTED' }
          : { status: S.CANCELED, resolution: 'MANUALLY_ABANDONED' };
    await tx.devicePrintJob.update({ where: { id }, data: { ...data, resolvedByUserId: actor.userId, leaseExpiresAt: null } });
    await audit(tx, { shopId: actor.shopId, actorUserId: actor.userId, actorType: 'SHOP_OWNER', action: 'printJob.reconciled', targetType: 'DevicePrintJob', targetId: id, metadata: { resolution: input.resolution } });
    return tx.devicePrintJob.findUniqueOrThrow({ where: { id }, include: { printer: true } });
  });
  announce(ctx, [change(out)]);
  if (input.resolution === 'NOT_PRINTED_REQUEUE') {
    const again = await enqueuePrintJob(ctx, {
      shopId: actor.shopId, userId: actor.userId, orderId: out.orderId, clientRequestId: input.clientRequestId!,
      printerId: out.printerId, acknowledgeDuplicateRisk: true, reprint: true
    });
    return { job: jobView(out), next: again.job };
  }
  return { job: jobView(out), next: null };
}

/* ------------------------------ device side ------------------------------ */

const deviceJobView = (j: DevicePrintJob & { printer: Pick<DevicePrinter, 'id' | 'name'> }) => ({
  id: j.id,
  orderId: j.orderId,
  status: j.status,
  attempt: j.attempt,
  leaseId: j.leaseId,
  leaseExpiresAt: j.leaseExpiresAt,
  cancelRequested: j.status === S.CANCEL_REQUESTED,
  statusBeforeCancel: j.statusBeforeCancel,
  printer: { id: j.printer.id, name: j.printer.name },
  options: j.options as unknown as JobOptions,
  spoolerJobId: j.spoolerJobId,
  /** The agent uses this name to find its own job in the spooler after a crash. */
  documentName: `pb-${j.id}-${j.attempt}`
});

/** Atomic claim. One in-flight job per device: if one is already held, it is returned again (resume), never a second. */
export async function claimNext(ctx: AppContext, me: DeviceRef) {
  const { prisma } = ctx;
  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'print-claim:' + me.deviceId}))`;
    const recovered = await recoverExpiredLeases(tx, { deviceId: me.deviceId });
    const now = new Date();
    const held = await tx.devicePrintJob.findFirst({
      where: { deviceId: me.deviceId, shopId: me.shopId, status: { in: LEASED }, leaseExpiresAt: { gte: now } },
      include: { printer: true },
      orderBy: { createdAt: 'asc' }
    });
    if (held) {
      const renewed = await tx.devicePrintJob.update({ where: { id: held.id }, data: { leaseExpiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000) }, include: { printer: true } });
      return { job: renewed, resumed: true, recovered, claimed: false };
    }
    const next = await tx.devicePrintJob.findFirst({
      where: { deviceId: me.deviceId, shopId: me.shopId, status: S.QUEUED, printer: { authorized: true, present: true } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    if (!next) return { job: null, resumed: false, recovered, claimed: false };
    const leaseId = randomUUID();
    const res = await tx.devicePrintJob.updateMany({
      where: { id: next.id, status: S.QUEUED, deviceId: me.deviceId, shopId: me.shopId },
      data: { status: S.CLAIMED, attempt: { increment: 1 }, leaseId, leaseExpiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000), errorCode: null, errorMessage: null }
    });
    if (res.count !== 1) return { job: null, resumed: false, recovered, claimed: false };
    const job = await tx.devicePrintJob.findUniqueOrThrow({ where: { id: next.id }, include: { printer: true } });
    await audit(tx, { shopId: me.shopId, actorUserId: null, actorType: 'SHOP_DEVICE', actorDeviceId: me.deviceId, action: 'printJob.claimed', targetType: 'DevicePrintJob', targetId: job.id, metadata: { attempt: job.attempt } });
    return { job, resumed: false, recovered, claimed: true };
  });
  announce(ctx, [...out.recovered, ...(out.claimed && out.job ? [change(out.job)] : [])]);
  return { job: out.job ? deviceJobView(out.job) : null, resumed: out.resumed };
}

/** Everything non-terminal that belongs to this device (restart recovery view). */
export async function activeJobs(ctx: AppContext, me: DeviceRef) {
  const changes = await recoverExpiredLeases(ctx.prisma, { deviceId: me.deviceId });
  announce(ctx, changes);
  const rows = await ctx.prisma.devicePrintJob.findMany({
    where: { deviceId: me.deviceId, shopId: me.shopId, status: { in: [...LEASED, S.NEEDS_RECONCILIATION] } },
    include: { printer: true },
    orderBy: { createdAt: 'asc' },
    take: 20
  });
  return rows.map(deviceJobView);
}

export interface ProgressInput {
  leaseId: string;
  status: AgentReportStatus;
  spoolerJobId?: number | undefined;
  spoolerState?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * Agent progress report. Only the lease holder of a job targeted at THIS device in THIS shop can move it, along explicit
 * edges. A repeat of the current status is a no-op that renews the lease (so lost acknowledgements can be replayed).
 */
export async function reportProgress(ctx: AppContext, me: DeviceRef, jobId: string, input: ProgressInput) {
  const out = await ctx.prisma.$transaction(async (tx) => {
    await lockJob(tx, jobId);
    const recovered = await recoverExpiredLeases(tx, { jobId });
    const job = await tx.devicePrintJob.findFirst({ where: { id: jobId, shopId: me.shopId, deviceId: me.deviceId }, include: { printer: true } });
    if (!job) throw printJobNotFound();
    if (!job.leaseId || job.leaseId !== input.leaseId) throw conflict('LEASE_MISMATCH', 'This job is not leased to the caller', { status: job.status });
    const now = new Date();
    const to = input.status;
    const errorCode = input.errorCode && errorCodeRe.test(input.errorCode) ? input.errorCode : input.errorCode ? 'AGENT_ERROR' : null;
    const spooler: Prisma.DevicePrintJobUpdateInput = {
      ...(input.spoolerJobId !== undefined && job.spoolerJobId === null ? { spoolerJobId: input.spoolerJobId } : {}),
      ...(input.spoolerState !== undefined ? { spoolerState: safeText(input.spoolerState, 80) } : {})
    };
    const lease = new Date(now.getTime() + LEASE_SECONDS * 1000);

    if (to === job.status) {
      // Idempotent repeat. Leased states renew the lease; terminal ones change nothing.
      if (LEASED.includes(job.status)) {
        await tx.devicePrintJob.update({ where: { id: jobId }, data: { ...spooler, leaseExpiresAt: lease } });
      } else if (Object.keys(spooler).length) {
        await tx.devicePrintJob.update({ where: { id: jobId }, data: spooler });
      }
      return { job: await tx.devicePrintJob.findUniqueOrThrow({ where: { id: jobId }, include: { printer: true } }), recovered, moved: false };
    }
    if (job.status === S.CANCEL_REQUESTED && !AGENT_EDGES.CANCEL_REQUESTED.includes(to)) {
      throw conflict('JOB_CANCEL_REQUESTED', 'The shop canceled this job. Stop and report CANCELED.', { status: job.status });
    }
    if (!AGENT_EDGES[job.status].includes(to)) {
      throw conflict('INVALID_STATUS_TRANSITION', `Invalid print job transition: ${job.status} -> ${to}`, { from: job.status, to });
    }
    if (job.status === S.CANCEL_REQUESTED && to !== S.CANCELED && to !== S.FAILED) {
      // Only legal when a submission had already started before the cancel arrived.
      if (!job.statusBeforeCancel || !SUBMISSION_STARTED.has(job.statusBeforeCancel)) {
        throw conflict('JOB_CANCEL_REQUESTED', 'The shop canceled this job. Stop and report CANCELED.', { status: job.status });
      }
    }
    const data: Prisma.DevicePrintJobUpdateInput = { status: to, ...spooler };
    if (to === S.SUBMITTING && !job.submittingAt) data.submittingAt = now;
    if (to === S.PRINT_INITIATED) data.printInitiatedAt = job.printInitiatedAt ?? now;
    if (to === S.FAILED || to === S.NEEDS_RECONCILIATION) {
      data.errorCode = errorCode ?? (to === S.FAILED ? 'AGENT_ERROR' : 'OUTCOME_UNKNOWN');
      data.errorMessage = safeText(input.errorMessage);
    }
    if (to === S.CANCELED) data.errorCode = null;
    // Leases: active work renews it; anything final (or waiting for a human) releases the timer but keeps leaseId for replays.
    data.leaseExpiresAt = ([S.DOWNLOADING, S.SUBMITTING, S.SUBMITTED_TO_SPOOLER] as S[]).includes(to) ? lease : null;
    // The conditional write is the real guard (the row is also FOR UPDATE-locked).
    const res = await tx.devicePrintJob.updateMany({ where: { id: jobId, status: job.status, leaseId: input.leaseId }, data: data as Prisma.DevicePrintJobUpdateManyMutationInput });
    if (res.count !== 1) throw conflict('INVALID_STATUS_TRANSITION', 'The job changed concurrently', { from: job.status, to });
    await audit(tx, {
      shopId: me.shopId, actorUserId: null, actorType: 'SHOP_DEVICE', actorDeviceId: me.deviceId, action: 'printJob.progress',
      targetType: 'DevicePrintJob', targetId: jobId, metadata: { from: job.status, to, ...(errorCode ? { errorCode } : {}) }
    });
    return { job: await tx.devicePrintJob.findUniqueOrThrow({ where: { id: jobId }, include: { printer: true } }), recovered, moved: true };
  });
  announce(ctx, [...out.recovered, ...(out.moved ? [change(out.job)] : [])]);
  return deviceJobView(out.job);
}

/** Short-lived document access for the lease holder, only while the job is CLAIMED/DOWNLOADING, only for ITS document. */
export async function issueJobDownload(ctx: AppContext, me: DeviceRef, jobId: string, leaseId: string) {
  const { prisma, storage } = ctx;
  const job = await prisma.devicePrintJob.findFirst({ where: { id: jobId, shopId: me.shopId, deviceId: me.deviceId } });
  if (!job) throw printJobNotFound();
  if (!job.leaseId || job.leaseId !== leaseId) throw conflict('LEASE_MISMATCH', 'This job is not leased to the caller');
  if ((job.status !== S.CLAIMED && job.status !== S.DOWNLOADING) || !job.leaseExpiresAt || job.leaseExpiresAt.getTime() < Date.now()) {
    throw conflict('INVALID_STATUS_TRANSITION', 'The document can only be downloaded while the job is being prepared', { status: job.status });
  }
  const order = await prisma.order.findFirst({ where: { id: job.orderId, shopId: me.shopId, documentId: job.documentId }, include: { document: true } });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  const doc = order.document;
  const window = documentAccessWindow(doc, order.status, Date.now());
  if (!window || !doc.detectedMimeType) throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'The document is no longer available');
  const ttl = Math.min(window.ttlSeconds, DOWNLOAD_URL_MAX_SECONDS);
  const access = await storage.temporaryReadUrl(doc.objectKey, ttl, { contentType: doc.detectedMimeType, disposition: 'attachment' });
  await audit(prisma, { shopId: me.shopId, actorUserId: null, actorType: 'SHOP_DEVICE', actorDeviceId: me.deviceId, action: 'printJob.documentAccess', targetType: 'DevicePrintJob', targetId: jobId });
  return {
    url: access.url,
    expiresAt: new Date(Math.min(access.expiresAt.getTime(), window.deadline.getTime())),
    mimeType: doc.detectedMimeType,
    byteSize: doc.byteSize === null ? null : Number(doc.byteSize),
    sha256: doc.checksum
  };
}
