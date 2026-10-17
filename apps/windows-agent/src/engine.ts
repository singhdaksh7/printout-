import { ApiError, assertSafeDownloadUrl, type AgentApi } from './api-client.js';
import { downloadToFile, readEnds } from './download.js';
import { Journal, type JobMemory } from './journal.js';
import type { Logger } from './logger.js';
import type { DeviceJob, PrinterReport, ProgressReport, ReportStatus, SupportedMime } from './protocol.js';
import { SubmitError, type Spooler, type SpoolerJob } from './spooler.js';
import { TempFiles, type TempHandle } from './tempfiles.js';
import { isSupportedMime, validateDocument, ValidationError } from './validate.js';

/**
 * The print engine: one job at a time, strictly ordered, crash-safe.
 *
 *   claim -> printer check -> DOWNLOADING -> download + validate -> SUBMITTING (acked) -> journal -> spooler
 *         -> SUBMITTED_TO_SPOOLER -> monitor queue -> PRINT_INITIATED
 *
 * NON-NEGOTIABLE RULES
 *  1. The agent never claims physical printing. Its strongest statement is PRINT_INITIATED.
 *  2. Once SUBMITTING was acknowledged and journaled, this process (or a restarted one) NEVER submits that job again.
 *     Anything unclear afterwards is reported as NEEDS_RECONCILIATION or FAILED (with duplicate risk) for a human.
 *  3. Nothing is submitted unless the server acknowledged the SUBMITTING intent (a cancel or revocation can still stop it).
 *  4. Pre-submission failures are always safe to retry and are reported before SUBMITTING.
 */
export interface EngineConfig {
  apiBase: string;
  allowInsecureLoopback: boolean;
  pollIntervalMs: number;
  housekeepingIntervalMs: number;
  printerReportIntervalMs: number;
  maxDocumentBytes: number;
  /** How long the engine watches a job in the spooler before handing the decision to a human. */
  monitorMs: number;
  monitorPollMs: number;
  /** How often a long-running phase renews its lease (and thereby learns about a cancel request). */
  leaseRenewMs: number;
  /** How long to wait for a freshly submitted job to show up in the queue. */
  appearMs: number;
  downloadAttempts: number;
  appVersion: string;
  osVersion: string;
}

export interface EngineDeps {
  api: AgentApi;
  spooler: Spooler;
  journal: Journal;
  temp: TempFiles;
  log: Logger;
  config: EngineConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Credential rotation hook (null when rotation is not wired, e.g. in unit tests). */
  maybeRotate?: () => Promise<void>;
  fetchImpl?: typeof fetch;
}

export type EngineStop = 'revoked' | 'stopped';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Server refused the report in a way the caller must act on (cancel requested, lease lost, invalid edge). */
class ReportRejected extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
/** The report could not be delivered (network). Callers decide whether proceeding is safe. */
class ReportUndelivered extends Error {}

const ERROR_FLAGS = ['Error', 'Offline', 'PaperOut', 'UserIntervention', 'Blocked', 'BlockedDeviceQueue', 'PaperJam', 'Restarted'];
const DONE_FLAGS = ['Printing', 'Printed', 'Complete', 'Completed'];

export class Engine {
  private stopRequested = false;
  private stopReason: EngineStop = 'stopped';
  private lastHeartbeat = 0;
  private lastPrinterReport = 0;
  private lastPrinterSignature = '';
  private lastHousekeeping = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private backoffMs = 0;

  constructor(private readonly d: EngineDeps) {
    this.sleep = d.sleep ?? defaultSleep;
    this.now = d.now ?? Date.now;
  }

  stop(reason: EngineStop = 'stopped') {
    this.stopRequested = true;
    this.stopReason = reason;
  }

  /** Runs until stop() or until the server revokes this device. */
  async run(): Promise<EngineStop> {
    await this.recover().catch((e) => this.d.log.warn('startup recovery incomplete', { error: String(e) }));
    while (!this.stopRequested) {
      try {
        await this.tick();
        this.backoffMs = 0;
        await this.sleep(this.d.config.pollIntervalMs + Math.floor(Math.random() * 500));
      } catch (e) {
        if (e instanceof ApiError && e.fatalAuth) {
          this.d.log.error('the server rejected this device credential (revoked or removed); stopping', { code: e.code });
          this.stop('revoked');
          break;
        }
        this.backoffMs = Math.min(60_000, this.backoffMs ? this.backoffMs * 2 : 1000);
        this.d.log.warn('tick failed; will retry', { error: e instanceof Error ? e.message : String(e), retryInMs: this.backoffMs });
        await this.sleep(this.backoffMs + Math.floor(Math.random() * 500));
      }
    }
    return this.stopReason;
  }

  /** One scheduling pass. Throws ApiError on transport/auth problems so run() can back off or stop. */
  async tick(): Promise<void> {
    const t = this.now();
    if (t - this.lastHeartbeat >= 60_000 || this.lastHeartbeat === 0) {
      await this.d.api.heartbeat({ appVersion: this.d.config.appVersion, osVersion: this.d.config.osVersion });
      this.lastHeartbeat = t;
    }
    await this.syncPrinters(false);
    await this.replayUnacked();
    if (t - this.lastHousekeeping >= this.d.config.housekeepingIntervalMs) {
      this.d.temp.sweep(t);
      this.d.journal.compact();
      this.lastHousekeeping = t;
    }
    const { job } = await this.d.api.claim();
    if (job) {
      await this.processJob(job);
      return;
    }
    await this.d.maybeRotate?.().catch((e) => this.d.log.warn('credential rotation failed; will retry later', { error: String(e) }));
  }

  /* ------------------------------ startup recovery ------------------------------ */

  async recover(): Promise<void> {
    this.d.temp.sweep(this.now());
    await this.replayUnacked();
    // Ambiguous jobs of ours: if the spooler shows them, attach that evidence (the server only allows this for the lease holder).
    const mem = this.d.journal.state();
    for (const job of await this.d.api.active()) {
      if (job.status !== 'NEEDS_RECONCILIATION') continue;
      const m = mem.get(job.id);
      if (!m?.submitBegun || m.leaseId !== job.leaseId) continue;
      const found = await this.findOurJob(m).catch(() => null);
      if (found) {
        await this.report(job, { status: 'SUBMITTED_TO_SPOOLER', spoolerJobId: found.id, spoolerState: found.flags.join(',') || 'queued' }).catch(() => undefined);
      }
    }
  }

  /** Replays reports the server may not have received (lost acknowledgement). Idempotent on the server. */
  private async replayUnacked(): Promise<void> {
    for (const m of this.d.journal.state().values()) {
      if (!m.unacked) continue;
      const u = m.unacked;
      try {
        await this.d.api.progress(m.jobId, { leaseId: u.leaseId, status: u.status, ...(u.spoolerJobId !== undefined ? { spoolerJobId: u.spoolerJobId } : {}), ...(u.spoolerState ? { spoolerState: u.spoolerState } : {}), ...(u.errorCode ? { errorCode: u.errorCode } : {}), ...(u.errorMessage ? { errorMessage: u.errorMessage } : {}) });
        this.d.journal.append({ ev: 'acked', jobId: m.jobId, status: u.status });
        if (isFinal(u.status)) this.d.journal.append({ ev: 'done', jobId: m.jobId });
      } catch (e) {
        if (e instanceof ApiError && !e.retryable && !e.fatalAuth) {
          // The server refused (lease moved on / job already resolved): nothing left to deliver.
          this.d.log.warn('dropping an undeliverable report', { jobId: m.jobId, code: e.code });
          this.d.journal.append({ ev: 'acked', jobId: m.jobId, status: u.status });
          this.d.journal.append({ ev: 'done', jobId: m.jobId });
        } else if (e instanceof ApiError && e.fatalAuth) throw e;
        /* retryable: keep it in the journal */
      }
    }
  }

  /* ------------------------------ printers ------------------------------ */

  async syncPrinters(force: boolean): Promise<PrinterReport[]> {
    const t = this.now();
    if (!force && this.lastPrinterReport !== 0 && t - this.lastPrinterReport < 60_000) return [];
    const printers = await this.d.spooler.listPrinters();
    const sig = JSON.stringify(printers);
    if (force || sig !== this.lastPrinterSignature || t - this.lastPrinterReport >= this.d.config.printerReportIntervalMs) {
      await this.d.api.reportPrinters(printers);
      this.lastPrinterSignature = sig;
    }
    this.lastPrinterReport = t;
    return printers;
  }

  /* ------------------------------ reporting ------------------------------ */

  /**
   * Journals the report first, then delivers it with bounded retries. On success the journal entry is acknowledged.
   * Throws ReportRejected (server said no) or ReportUndelivered (network); fatal auth errors propagate as ApiError.
   */
  private async report(job: Pick<DeviceJob, 'id' | 'leaseId'>, rep: Omit<ProgressReport, 'leaseId'>): Promise<DeviceJob> {
    if (!job.leaseId) throw new ReportRejected('NO_LEASE');
    const body: ProgressReport = { leaseId: job.leaseId, ...rep };
    this.d.journal.append({ ev: 'report', jobId: job.id, leaseId: job.leaseId, status: rep.status, ...(rep.spoolerJobId !== undefined ? { spoolerJobId: rep.spoolerJobId } : {}), ...(rep.spoolerState ? { spoolerState: rep.spoolerState } : {}), ...(rep.errorCode ? { errorCode: rep.errorCode } : {}), ...(rep.errorMessage ? { errorMessage: rep.errorMessage } : {}) });
    for (let attempt = 0; ; attempt++) {
      try {
        const updated = await this.d.api.progress(job.id, body);
        this.d.journal.append({ ev: 'acked', jobId: job.id, status: rep.status });
        if (isFinal(rep.status)) this.d.journal.append({ ev: 'done', jobId: job.id });
        return updated;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.fatalAuth) throw e;
        if (!e.retryable) {
          this.d.journal.append({ ev: 'acked', jobId: job.id, status: rep.status }); // refused: nothing to replay
          throw new ReportRejected(e.code);
        }
        if (attempt >= 4) throw new ReportUndelivered(e.message);
        await this.sleep(Math.min(8000, 1000 * 2 ** attempt));
      }
    }
  }

  /** Terminal failure BEFORE anything reached the spooler. */
  private async failSafely(job: DeviceJob, code: string, message: string): Promise<void> {
    this.d.log.warn('job failed before submission', { jobId: job.id, code });
    await this.report(job, { status: 'FAILED', errorCode: code, errorMessage: message }).catch((e) => this.swallow(job, e));
  }

  private swallow(job: DeviceJob, e: unknown) {
    if (e instanceof ApiError && e.fatalAuth) throw e;
    this.d.log.warn('report not delivered', { jobId: job.id, reason: e instanceof Error ? e.message : String(e) });
  }

  /* ------------------------------ job processing ------------------------------ */

  async processJob(job: DeviceJob): Promise<void> {
    if (!job.leaseId) return;
    const mem = this.d.journal.state().get(job.id);
    if (!mem || mem.leaseId !== job.leaseId) {
      this.d.journal.append({ ev: 'claimed', jobId: job.id, attempt: job.attempt, leaseId: job.leaseId, printerName: job.printer.name });
    }
    this.d.log.info('processing job', { jobId: job.id, status: job.status, attempt: job.attempt });
    switch (job.status) {
      case 'CLAIMED':
      case 'DOWNLOADING':
        return this.prepareAndPrint(job, this.d.journal.state().get(job.id));
      case 'SUBMITTING':
      case 'SUBMITTED_TO_SPOOLER':
        return this.recoverSubmitted(job);
      case 'CANCEL_REQUESTED':
        return this.handleCancel(job);
      default:
        return;
    }
  }

  private async prepareAndPrint(job: DeviceJob, mem: JobMemory | undefined): Promise<void> {
    const { spooler, temp, config, log } = this.d;
    if (mem?.submitBegun) {
      // Journal says a submission began but the server is still before SUBMITTING: inconsistent. Never print on a guess.
      return this.failSafely(job, 'INCONSISTENT_STATE', 'The agent found an inconsistent job record and did not print. Check the printer before printing again.');
    }

    // 1. The printer must exist locally and be usable. An offline printer would queue the job and print it LATER,
    //    long after the shop gave up on it, so we refuse up front instead.
    let printers: PrinterReport[];
    try {
      printers = await spooler.listPrinters();
    } catch {
      return this.failSafely(job, 'SPOOLER_UNAVAILABLE', 'The Windows print service could not be queried');
    }
    const printer = printers.find((p) => p.name === job.printer.name);
    if (!printer) return this.failSafely(job, 'PRINTER_NOT_FOUND', 'The printer is not installed on this computer');
    if (printer.connectivity === 'OFFLINE' || printer.connectivity === 'ERROR') {
      return this.failSafely(job, 'PRINTER_OFFLINE', `The printer is not ready (${printer.statusDetail ?? printer.connectivity})`);
    }
    const o = job.options;
    if (o.colourMode === 'colour' && !printer.supportsColour) return this.failSafely(job, 'UNSUPPORTED_OPTIONS', 'The printer does not support colour');
    if (o.sides === 'duplex' && !printer.supportsDuplex) return this.failSafely(job, 'UNSUPPORTED_OPTIONS', 'The printer does not support two-sided printing');

    // 2. DOWNLOADING (acknowledged). A 409 means the shop canceled or the lease moved on.
    try {
      await this.report(job, { status: 'DOWNLOADING' });
    } catch (e) {
      return this.afterRejectedBeforeSubmit(job, e);
    }

    // 3. Download + validate.
    let handle: TempHandle | null = null;
    try {
      const prepared = await this.download(job);
      handle = prepared.handle;
      const mime = prepared.mime;

      // 4. Intent: the server must acknowledge SUBMITTING, then it is journaled, THEN the spooler is touched.
      let queuedIds: number[];
      try {
        queuedIds = (await spooler.listJobs(job.printer.name)).map((j) => j.id);
      } catch {
        return await this.failSafely(job, 'SPOOLER_UNAVAILABLE', 'The print queue could not be read');
      }
      try {
        await this.report(job, { status: 'SUBMITTING' });
      } catch (e) {
        return await this.afterRejectedBeforeSubmit(job, e);
      }
      const documentName = job.documentName;
      this.d.journal.append({ ev: 'submit-begin', jobId: job.id, attempt: job.attempt, leaseId: job.leaseId!, printerName: job.printer.name, documentName, queuedIds });

      // 5. Hand over to the spooler. From here on there is NO automatic retry.
      let submitError: SubmitError | null = null;
      try {
        await spooler.submit({ printerName: job.printer.name, filePath: handle.filePath, mime, documentName, options: o });
      } catch (e) {
        submitError = e instanceof SubmitError ? e : new SubmitError('AFTER_START', 'RENDERER_EXIT', 'Printing did not finish cleanly');
      }
      handle.cleanup(); // the spooler has its own copy; our temporary file is no longer needed
      handle = null;

      const outcome = await this.waitForSpoolerJob(job.printer.name, documentName, queuedIds);
      if (outcome === 'ambiguous') {
        // Several unknown jobs appeared: we cannot tell which one is ours, so we must not guess.
        return await this.finish(job, 'NEEDS_RECONCILIATION', 'SPOOLER_JOB_AMBIGUOUS', 'The job was sent, but the print queue changed at the same time so it could not be identified. Check the printer before printing again.');
      }
      const found = outcome;
      if (submitError) {
        log.warn('submission reported an error', { jobId: job.id, code: submitError.code, kind: submitError.kind });
        if (found) {
          // The spooler holds the job despite the renderer error: track it, do not hide it.
          this.d.journal.append({ ev: 'submitted', jobId: job.id, spoolerJobId: found.id });
          await this.report(job, { status: 'SUBMITTED_TO_SPOOLER', spoolerJobId: found.id, spoolerState: found.flags.join(',') || 'queued' });
          return await this.monitor(job, found.id);
        }
        return await this.finish(job, 'FAILED', submitError.code, submitError.kind === 'NOT_STARTED'
          ? 'The job was not sent to the printer.'
          : 'The renderer stopped unexpectedly. The job may or may not have been sent to the printer; check the printer before printing again.');
      }
      if (!found) {
        // Renderer succeeded but the job left the queue before we could see it (fast printer). Say exactly that.
        this.d.journal.append({ ev: 'submitted', jobId: job.id, spoolerJobId: null });
        return await this.finish(job, 'PRINT_INITIATED', undefined, undefined, { spoolerState: 'left-queue-before-observed' });
      }
      this.d.journal.append({ ev: 'submitted', jobId: job.id, spoolerJobId: found.id });
      await this.report(job, { status: 'SUBMITTED_TO_SPOOLER', spoolerJobId: found.id, spoolerState: found.flags.join(',') || 'queued' });
      await this.monitor(job, found.id);
    } catch (e) {
      if (e instanceof ApiError && e.fatalAuth) throw e;
      if (e instanceof PrepareFailure) {
        if (e.code === 'DOWNLOAD_REFUSED') {
          // A refused download usually means the shop canceled in the meantime: probe, and honour the cancel.
          try {
            await this.report(job, { status: 'DOWNLOADING' });
          } catch (probe) {
            if (probe instanceof ReportRejected && probe.code === 'JOB_CANCEL_REQUESTED') return this.afterRejectedBeforeSubmit(job, probe);
          }
        }
        return this.failSafely(job, e.code, e.message);
      }
      if (e instanceof ReportRejected || e instanceof ReportUndelivered) {
        // We could not tell the server what happened. If the spooler may already hold the job, the journal has the
        // unacknowledged report and recovery will replay it; we never resubmit.
        log.warn('report problem during job', { jobId: job.id, reason: e.message });
        return;
      }
      log.error('unexpected error during job', { jobId: job.id, error: e instanceof Error ? e.message : String(e) });
      const m = this.d.journal.state().get(job.id);
      if (m?.submitBegun) {
        await this.report(job, { status: 'NEEDS_RECONCILIATION', errorCode: 'AGENT_ERROR', errorMessage: 'The agent hit an unexpected error after sending the job to the printer.' }).catch((er) => this.swallow(job, er));
      } else {
        await this.failSafely(job, 'AGENT_ERROR', 'The agent hit an unexpected error before sending the job to the printer.');
      }
    } finally {
      handle?.cleanup();
    }
  }

  /** The server refused a pre-submission report: stop quietly (cancel) or give up (lease moved on). Never submit. */
  private async afterRejectedBeforeSubmit(job: DeviceJob, e: unknown): Promise<void> {
    if (e instanceof ReportRejected && e.code === 'JOB_CANCEL_REQUESTED') {
      this.d.log.info('job canceled by the shop before submission', { jobId: job.id });
      await this.report(job, { status: 'CANCELED' }).catch((er) => this.swallow(job, er));
      return;
    }
    if (e instanceof ReportRejected) {
      this.d.log.warn('server refused a report; abandoning the job locally', { jobId: job.id, code: e.code });
      this.d.journal.append({ ev: 'done', jobId: job.id });
      return;
    }
    if (e instanceof ReportUndelivered) {
      this.d.log.warn('server unreachable before submission; not printing', { jobId: job.id });
      return; // the lease will expire and the job is re-queued (nothing was submitted)
    }
    throw e;
  }

  private async download(job: DeviceJob): Promise<{ handle: TempHandle; mime: SupportedMime }> {
    const { api, config, spooler, temp } = this.d;
    let lastError: unknown;
    for (let attempt = 1; attempt <= config.downloadAttempts; attempt++) {
      let handle: TempHandle | null = null;
      try {
        const access = await api.download(job.id, job.leaseId!);
        if (!isSupportedMime(access.mimeType)) throw new PrepareFailure('UNSUPPORTED_TYPE', 'This document type cannot be printed by the agent');
        const supported = await spooler.supportedMimeTypes();
        if (!supported.includes(access.mimeType)) {
          throw new PrepareFailure(access.mimeType === 'application/pdf' ? 'RENDERER_MISSING' : 'UNSUPPORTED_TYPE', access.mimeType === 'application/pdf' ? 'No PDF renderer is installed on this computer' : 'This computer cannot print this document type');
        }
        const url = assertSafeDownloadUrl(access.url, config.apiBase, config.allowInsecureLoopback);
        handle = temp.allocate(job.id, job.attempt, access.mimeType);
        await downloadToFile(url, handle.filePath, {
          maxBytes: config.maxDocumentBytes,
          expectedSize: access.byteSize,
          expectedSha256: access.sha256,
          ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {})
        });
        const ends = readEnds(handle.filePath);
        const mime = validateDocument({ declaredMime: access.mimeType, size: ends.size, maxBytes: config.maxDocumentBytes, head: ends.head, tail: ends.tail, supported });
        return { handle, mime };
      } catch (e) {
        handle?.cleanup();
        lastError = e;
        if (e instanceof ValidationError) throw new PrepareFailure(e.code, e.message);
        if (e instanceof PrepareFailure) throw e;
        if (e instanceof ApiError) {
          if (e.fatalAuth) throw e;
          if (!e.retryable) throw new PrepareFailure(e.code === 'DOCUMENT_UNAVAILABLE' ? 'DOCUMENT_UNAVAILABLE' : 'DOWNLOAD_REFUSED', 'The document could not be fetched');
        }
        this.d.log.warn('download attempt failed', { jobId: job.id, attempt, error: e instanceof Error ? e.message : String(e) });
        if (attempt < config.downloadAttempts) {
          await this.sleep(1000 * attempt);
          await this.report(job, { status: 'DOWNLOADING' }).catch(() => undefined); // renews the lease
        }
      }
    }
    void lastError;
    throw new PrepareFailure('DOWNLOAD_FAILED', 'The document could not be downloaded');
  }

  /** Polls the queue for the job we just submitted: by document name first, otherwise the single new job. */
  private async waitForSpoolerJob(printerName: string, documentName: string, queuedBefore: number[]): Promise<SpoolerJob | 'ambiguous' | null> {
    const deadline = this.now() + this.d.config.appearMs;
    for (;;) {
      let jobs: SpoolerJob[] = [];
      try {
        jobs = await this.d.spooler.listJobs(printerName);
      } catch {
        /* transient: keep polling until the deadline */
      }
      const fresh = jobs.filter((j) => !queuedBefore.includes(j.id));
      const byName = fresh.find((j) => j.documentName.includes(documentName));
      if (byName) return byName;
      if (fresh.length === 1) return fresh[0]!;
      if (fresh.length > 1) return 'ambiguous'; // refuse to guess which one is ours
      if (this.now() >= deadline) return null;
      await this.sleep(Math.min(500, this.d.config.monitorPollMs));
    }
  }

  private async findOurJob(m: JobMemory): Promise<SpoolerJob | null> {
    const jobs = await this.d.spooler.listJobs(m.printerName);
    if (m.spoolerJobId !== null) {
      const known = jobs.find((j) => j.id === m.spoolerJobId);
      if (known) return known;
    }
    const byName = m.documentName ? jobs.filter((j) => j.documentName.includes(m.documentName!)) : [];
    if (byName.length === 1) return byName[0]!;
    const fresh = jobs.filter((j) => !m.queuedIds.includes(j.id));
    return byName.length === 0 && fresh.length === 1 ? fresh[0]! : null;
  }

  /** Watches the spooler queue. The strongest conclusion is PRINT_INITIATED: the spooler is processing or has finished with it. */
  private async monitor(job: DeviceJob, spoolerJobId: number): Promise<void> {
    const deadline = this.now() + this.d.config.monitorMs;
    let lastRenew = this.now();
    let seen = true;
    let lastState = '';
    for (;;) {
      let jobs: SpoolerJob[];
      try {
        jobs = await this.d.spooler.listJobs(job.printer.name);
      } catch {
        jobs = [];
      }
      const j = jobs.find((x) => x.id === spoolerJobId);
      if (!j) {
        if (seen) return this.finish(job, 'PRINT_INITIATED', undefined, undefined, { spoolerState: 'left-queue' });
      } else {
        seen = true;
        const state = j.flags.join(',') || 'queued';
        if (j.flags.some((f) => /deleting|deleted/i.test(f))) {
          return this.finish(job, 'NEEDS_RECONCILIATION', 'SPOOLER_JOB_DELETED', 'The job was removed from the print queue. Check whether anything printed.', { spoolerState: state });
        }
        if (j.flags.some((f) => DONE_FLAGS.includes(f)) && !j.flags.some((f) => ERROR_FLAGS.includes(f))) {
          return this.finish(job, 'PRINT_INITIATED', undefined, undefined, { spoolerState: state });
        }
        if (state !== lastState) {
          lastState = state;
          if (await this.renewDetectingCancel(job, { status: 'SUBMITTED_TO_SPOOLER', spoolerState: state })) return;
          lastRenew = this.now();
        }
      }
      if (this.now() >= deadline) {
        const state = j ? j.flags.join(',') || 'queued' : 'unknown';
        return this.finish(job, 'NEEDS_RECONCILIATION', j?.flags.some((f) => ERROR_FLAGS.includes(f)) ? 'SPOOLER_ERROR' : 'SPOOLER_STALLED',
          `The print queue still shows the job (${state}). It may print later; check the printer before printing again.`, { spoolerState: state });
      }
      if (this.now() - lastRenew > this.d.config.leaseRenewMs) {
        if (await this.renewDetectingCancel(job, { status: 'SUBMITTED_TO_SPOOLER' })) return;
        lastRenew = this.now();
      }
      await this.sleep(this.d.config.monitorPollMs);
    }
  }

  /** Lease renewal during monitoring. Returns true when the shop canceled meanwhile (the cancel path has then been run). */
  private async renewDetectingCancel(job: DeviceJob, rep: Omit<ProgressReport, 'leaseId'>): Promise<boolean> {
    try {
      await this.report(job, rep);
      return false;
    } catch (e) {
      if (e instanceof ReportRejected && e.code === 'JOB_CANCEL_REQUESTED') {
        await this.handleCancel({ ...job, status: 'CANCEL_REQUESTED', cancelRequested: true, statusBeforeCancel: 'SUBMITTED_TO_SPOOLER' });
        return true;
      }
      this.swallow(job, e);
      return false;
    }
  }

  private async finish(
    job: DeviceJob,
    status: Extract<ReportStatus, 'PRINT_INITIATED' | 'FAILED' | 'NEEDS_RECONCILIATION'>,
    errorCode?: string,
    errorMessage?: string,
    extra: { spoolerState?: string } = {}
  ): Promise<void> {
    await this.report(job, { status, ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}), ...extra }).catch((e) => this.swallow(job, e));
  }

  /* ------------------------------ recovery paths ------------------------------ */

  /** The server says SUBMITTING/SUBMITTED_TO_SPOOLER for a job we hold: we crashed or restarted. NEVER resubmit. */
  private async recoverSubmitted(job: DeviceJob): Promise<void> {
    const m = this.d.journal.state().get(job.id);
    if (!m?.submitBegun || m.leaseId !== job.leaseId) {
      this.d.log.warn('restart before the spooler was touched; nothing was sent', { jobId: job.id });
      if (job.status === 'SUBMITTING') return this.finish(job, 'FAILED', 'RESTARTED_BEFORE_SUBMIT', 'The agent restarted before sending the job to the printer. Nothing was sent.');
      return this.finish(job, 'NEEDS_RECONCILIATION', 'OUTCOME_UNKNOWN', 'The agent lost track of this job. Check the printer before printing again.');
    }
    let found: SpoolerJob | null = null;
    try {
      found = await this.findOurJob(m);
    } catch {
      return; // spooler unreadable right now: try again on the next tick while the lease holds
    }
    if (found) {
      this.d.log.info('recovered the job from the spooler queue', { jobId: job.id });
      this.d.journal.append({ ev: 'submitted', jobId: job.id, spoolerJobId: found.id });
      await this.report(job, { status: 'SUBMITTED_TO_SPOOLER', spoolerJobId: found.id, spoolerState: found.flags.join(',') || 'queued' }).catch((e) => this.swallow(job, e));
      return this.monitor(job, found.id);
    }
    return this.finish(job, 'NEEDS_RECONCILIATION', 'OUTCOME_UNKNOWN', 'The agent restarted while sending the job. It is not in the print queue, so it may already have printed. Check the printer before printing again.');
  }

  /** The shop asked to cancel a job we hold. */
  private async handleCancel(job: DeviceJob): Promise<void> {
    const m = this.d.journal.state().get(job.id);
    const nothingSent = !m?.submitBegun && (job.statusBeforeCancel === 'CLAIMED' || job.statusBeforeCancel === 'DOWNLOADING');
    if (nothingSent) {
      this.d.log.info('cancel: nothing had been sent', { jobId: job.id });
      return this.cancelConfirmed(job);
    }
    return this.cancelSubmitted(job, m);
  }

  private async cancelSubmitted(job: DeviceJob, m: JobMemory | undefined): Promise<void> {
    let found: SpoolerJob | null = null;
    if (m) {
      try {
        found = await this.findOurJob(m);
      } catch {
        return; // retry next tick
      }
    }
    if (found) {
      const gone = await this.d.spooler.removeJob(job.printer.name, found.id).catch(() => false);
      if (gone) return this.cancelConfirmed(job);
      return this.finish(job, 'PRINT_INITIATED', undefined, undefined, { spoolerState: 'cancel-failed' });
    }
    if (m && m.spoolerJobId !== null) return this.finish(job, 'PRINT_INITIATED', undefined, undefined, { spoolerState: 'left-queue-before-cancel' });
    return this.finish(job, 'NEEDS_RECONCILIATION', 'OUTCOME_UNKNOWN', 'A cancel was requested but the job could not be found in the print queue. Check the printer.');
  }

  private async cancelConfirmed(job: DeviceJob): Promise<void> {
    await this.report(job, { status: 'CANCELED' }).catch((e) => this.swallow(job, e));
  }
}

class PrepareFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const isFinal = (s: ReportStatus) => s === 'PRINT_INITIATED' || s === 'FAILED' || s === 'CANCELED' || s === 'NEEDS_RECONCILIATION';
