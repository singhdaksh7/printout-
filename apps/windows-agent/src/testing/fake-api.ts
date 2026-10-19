import { createHash, randomUUID } from 'node:crypto';
import { ApiError, type AgentApi } from '../api-client.js';
import type { DeviceJob, JobOptions, JobStatus, PrinterReport, ProgressReport } from '../protocol.js';

/**
 * In-memory stand-in for the Printout Buddy API, implementing the SAME rules the real server enforces for the agent
 * (lease, explicit edges, cancel semantics). It exists so the Windows CI job can test the engine without PostgreSQL;
 * the real server is exercised by test/integration/engine-vs-api.test.ts and apps/api/test/windows-print-agent.test.ts.
 */
const EDGES: Record<JobStatus, JobStatus[]> = {
  QUEUED: [],
  CLAIMED: ['DOWNLOADING', 'FAILED'],
  DOWNLOADING: ['SUBMITTING', 'FAILED'],
  SUBMITTING: ['SUBMITTED_TO_SPOOLER', 'PRINT_INITIATED', 'FAILED', 'NEEDS_RECONCILIATION'],
  SUBMITTED_TO_SPOOLER: ['PRINT_INITIATED', 'FAILED', 'NEEDS_RECONCILIATION'],
  PRINT_INITIATED: ['FAILED', 'NEEDS_RECONCILIATION'],
  CANCEL_REQUESTED: ['CANCELED', 'FAILED', 'PRINT_INITIATED', 'NEEDS_RECONCILIATION'],
  CANCELED: [],
  FAILED: [],
  NEEDS_RECONCILIATION: ['SUBMITTED_TO_SPOOLER', 'PRINT_INITIATED']
};
const LEASED: JobStatus[] = ['CLAIMED', 'DOWNLOADING', 'SUBMITTING', 'SUBMITTED_TO_SPOOLER', 'CANCEL_REQUESTED'];
const STARTED: JobStatus[] = ['SUBMITTING', 'SUBMITTED_TO_SPOOLER', 'PRINT_INITIATED'];

export interface FakeJob {
  id: string;
  orderId: string;
  status: JobStatus;
  statusBeforeCancel: JobStatus | null;
  attempt: number;
  leaseId: string | null;
  printerName: string;
  options: JobOptions;
  spoolerJobId: number | null;
  spoolerState: string | null;
  errorCode: string | null;
  submittingAt: number | null;
  /** Document served for this job. */
  document: { mime: string; bytes: Buffer; declaredSha256?: string | null; declaredSize?: number | null };
}

export class FakeApi implements AgentApi {
  jobs: FakeJob[] = [];
  credential: string | null = null;
  heartbeats = 0;
  printerReports: PrinterReport[][] = [];
  downloads = 0;
  /** If set, requests throw it (network outage, revocation, ...). */
  failWith: ApiError | null = null;
  rotations = 0;
  /** URL the download endpoint answers with; tests point it at a local http server. */
  downloadUrl = 'http://127.0.0.1:1/never';
  hooks: { beforeProgress?: (jobId: string, r: ProgressReport) => void; afterProgress?: (jobId: string, r: ProgressReport) => void } = {};

  setCredential(secret: string) {
    this.credential = secret;
  }

  addJob(partial: Partial<FakeJob> & { document: FakeJob['document'] }): FakeJob {
    const job: FakeJob = {
      id: `job${String(this.jobs.length + 1).padStart(10, '0')}`,
      orderId: 'order00000001',
      status: 'QUEUED',
      statusBeforeCancel: null,
      attempt: 0,
      leaseId: null,
      printerName: 'Front Desk LaserJet',
      options: { copies: 1, colourMode: 'bw', sides: 'single', paperSize: 'A4', pageSelection: { mode: 'all' } },
      spoolerJobId: null,
      spoolerState: null,
      errorCode: null,
      submittingAt: null,
      ...partial
    };
    this.jobs.push(job);
    return job;
  }

  private gate() {
    if (this.failWith) throw this.failWith;
  }

  private view(j: FakeJob): DeviceJob {
    return {
      id: j.id,
      orderId: j.orderId,
      status: j.status,
      attempt: j.attempt,
      leaseId: j.leaseId,
      leaseExpiresAt: j.leaseId ? new Date(Date.now() + 120_000).toISOString() : null,
      cancelRequested: j.status === 'CANCEL_REQUESTED',
      statusBeforeCancel: j.statusBeforeCancel,
      printer: { id: 'printer0000001', name: j.printerName },
      options: j.options,
      spoolerJobId: j.spoolerJobId,
      documentName: `pb-${j.id}-${j.attempt}`
    };
  }

  async heartbeat() {
    this.gate();
    this.heartbeats++;
    return { heartbeatIntervalSeconds: 60 };
  }

  async reportPrinters(printers: PrinterReport[]) {
    this.gate();
    this.printerReports.push(printers);
    return printers.map((p, i) => ({ id: `p${i}`, name: p.name, authorized: true, isDefault: i === 0, present: true }));
  }

  async claim() {
    this.gate();
    const held = this.jobs.find((j) => LEASED.includes(j.status) && j.leaseId);
    if (held) return { job: this.view(held), resumed: true };
    const next = this.jobs.find((j) => j.status === 'QUEUED');
    if (!next) return { job: null, resumed: false };
    next.status = 'CLAIMED';
    next.attempt++;
    next.leaseId = randomUUID();
    return { job: this.view(next), resumed: false };
  }

  async active() {
    this.gate();
    return this.jobs.filter((j) => [...LEASED, 'NEEDS_RECONCILIATION'].includes(j.status)).map((j) => this.view(j));
  }

  async download(jobId: string, leaseId: string) {
    this.gate();
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j || j.leaseId !== leaseId) throw new ApiError(409, 'LEASE_MISMATCH', 'lease', false);
    if (j.status !== 'CLAIMED' && j.status !== 'DOWNLOADING') throw new ApiError(409, 'INVALID_STATUS_TRANSITION', 'state', false);
    this.downloads++;
    return {
      url: this.downloadUrl + '/' + j.id,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      mimeType: j.document.mime,
      byteSize: j.document.declaredSize === undefined ? j.document.bytes.length : j.document.declaredSize,
      sha256: j.document.declaredSha256 === undefined ? createHash('sha256').update(j.document.bytes).digest('hex') : j.document.declaredSha256
    };
  }

  async progress(jobId: string, r: ProgressReport) {
    this.gate();
    this.hooks.beforeProgress?.(jobId, r);
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j) throw new ApiError(404, 'PRINT_JOB_NOT_FOUND', 'nf', false);
    if (!j.leaseId || j.leaseId !== r.leaseId) throw new ApiError(409, 'LEASE_MISMATCH', 'lease', false);
    if (r.status !== j.status) {
      if (j.status === 'CANCEL_REQUESTED' && !EDGES.CANCEL_REQUESTED.includes(r.status)) throw new ApiError(409, 'JOB_CANCEL_REQUESTED', 'canceled', false);
      if (!EDGES[j.status].includes(r.status)) throw new ApiError(409, 'INVALID_STATUS_TRANSITION', `${j.status}->${r.status}`, false);
      if (j.status === 'CANCEL_REQUESTED' && r.status !== 'CANCELED' && r.status !== 'FAILED' && !(j.statusBeforeCancel && STARTED.includes(j.statusBeforeCancel))) {
        throw new ApiError(409, 'JOB_CANCEL_REQUESTED', 'canceled', false);
      }
      j.status = r.status;
      if (r.status === 'SUBMITTING' && !j.submittingAt) j.submittingAt = Date.now();
      if (r.errorCode) j.errorCode = r.errorCode;
    }
    if (r.spoolerJobId !== undefined && j.spoolerJobId === null) j.spoolerJobId = r.spoolerJobId;
    if (r.spoolerState) j.spoolerState = r.spoolerState;
    this.hooks.afterProgress?.(jobId, r);
    return this.view(j);
  }

  async rotate() {
    this.gate();
    this.rotations++;
    return { deviceCredential: `pbd_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, credentialVersion: this.rotations + 1, previousValidForSeconds: 600 };
  }

  /** What the shop would do: request cancel. */
  shopCancel(jobId: string) {
    const j = this.jobs.find((x) => x.id === jobId)!;
    if (j.status === 'QUEUED') j.status = 'CANCELED';
    else if (LEASED.includes(j.status) || j.status === 'PRINT_INITIATED') {
      j.statusBeforeCancel = j.status;
      j.status = 'CANCEL_REQUESTED';
    }
  }
}
