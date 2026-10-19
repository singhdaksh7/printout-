import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PrinterReport, SupportedMime } from '../protocol.js';
import { SubmitError, type Spooler, type SpoolerJob, type SubmitRequest } from '../spooler.js';

/**
 * Virtual printer for tests (NOT shipped in the agent bundle). Behaves like the Windows spooler as far as the engine can
 * observe it: printers with status/capabilities, a queue whose jobs progress through flag states per poll, renderer failures
 * and "the process died here" injection. It records every submission so tests can assert that a job was NEVER sent twice.
 */
export interface Submission {
  printerName: string;
  documentName: string;
  mime: SupportedMime;
  sha256: string;
  bytes: number;
  options: SubmitRequest['options'];
  fileExistedAtSubmit: boolean;
}

export type SubmitBehaviour =
  | 'ok'
  /** Renderer exits non-zero AFTER queuing the job. */
  | 'error-after-queue'
  /** Renderer exits non-zero and nothing was queued. */
  | 'error-nothing-queued'
  /** Renderer binary missing / cannot be started. */
  | 'not-started'
  /** Renderer succeeded but the job is already gone from the queue by the time anyone looks (fast printer). */
  | 'instant';

export class FakeSpooler implements Spooler {
  printers: PrinterReport[] = [
    { name: 'Front Desk LaserJet', driverName: 'Fake PCL6', connectivity: 'ONLINE', supportsColour: false, supportsDuplex: true, paperSizes: ['A4', 'Letter'] }
  ];
  pdfRenderer = true;
  behaviour: SubmitBehaviour = 'ok';
  /** Flag sets a new job walks through, one step per listJobs poll. Empty array => job leaves the queue. */
  lifecycle: string[][] = [['Spooling'], ['Printing'], []];
  removeSucceeds = true;
  /** The renderer names the spooler document something we cannot recognise. */
  opaqueNames = false;
  failListPrinters = false;
  failListJobs = false;
  submissions: Submission[] = [];
  /** Called right after a job entered the queue (before submit() returns): crash injection point. */
  onQueued?: () => void;
  /** Called at the start of submit(), before anything is queued. */
  onSubmitStart?: () => void;
  private nextId = 100;
  private readonly queue = new Map<string, Array<SpoolerJob & { step: number; hidden?: boolean }>>();

  async listPrinters(): Promise<PrinterReport[]> {
    if (this.failListPrinters) throw new Error('spooler unavailable');
    return this.printers.map((p) => ({ ...p }));
  }

  async supportedMimeTypes(): Promise<SupportedMime[]> {
    return this.pdfRenderer ? ['application/pdf', 'image/jpeg', 'image/png'] : ['image/jpeg', 'image/png'];
  }

  async listJobs(printerName: string): Promise<SpoolerJob[]> {
    if (this.failListJobs) throw new Error('queue unavailable');
    const jobs = this.queue.get(printerName) ?? [];
    const out: SpoolerJob[] = [];
    for (const j of jobs) {
      if (j.hidden) continue;
      out.push({ id: j.id, documentName: j.documentName, flags: [...j.flags], totalPages: j.totalPages, pagesPrinted: j.pagesPrinted });
      if (j.step < this.lifecycle.length) {
        j.flags = this.lifecycle[j.step]!;
        j.step++;
        if (j.flags.length === 0) j.hidden = true; // leaves the queue after being observed once more
      }
    }
    return out;
  }

  async submit(req: SubmitRequest): Promise<void> {
    this.onSubmitStart?.();
    if (this.behaviour === 'not-started') throw new SubmitError('NOT_STARTED', 'RENDERER_MISSING', 'renderer missing');
    const data = readFileSync(req.filePath);
    this.submissions.push({
      printerName: req.printerName,
      documentName: req.documentName,
      mime: req.mime,
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
      options: req.options,
      fileExistedAtSubmit: true
    });
    if (this.behaviour === 'error-nothing-queued') throw new SubmitError('AFTER_START', 'RENDERER_EXIT', 'renderer exit 1');
    const id = this.nextId++;
    const list = this.queue.get(req.printerName) ?? [];
    list.push({ id, documentName: this.opaqueNames ? 'Document' : `${req.documentName}.${req.mime === 'application/pdf' ? 'pdf' : 'img'}`, flags: this.behaviour === 'instant' ? [] : ['Spooling'], totalPages: 1, pagesPrinted: 0, step: 0, hidden: this.behaviour === 'instant' });
    this.queue.set(req.printerName, list);
    this.onQueued?.();
    if (this.behaviour === 'error-after-queue') throw new SubmitError('AFTER_START', 'RENDERER_EXIT', 'renderer exit 1');
  }

  async removeJob(printerName: string, jobId: number): Promise<boolean> {
    const list = this.queue.get(printerName) ?? [];
    const j = list.find((x) => x.id === jobId && !x.hidden);
    if (!j) return true;
    if (!this.removeSucceeds) return false;
    j.hidden = true;
    return true;
  }

  /** Test helper: put an unrelated job into a queue (someone else printing). */
  addForeignJob(printerName: string, documentName = 'Quarterly report.docx'): number {
    const id = this.nextId++;
    const list = this.queue.get(printerName) ?? [];
    list.push({ id, documentName, flags: ['Printing'], totalPages: 3, pagesPrinted: 1, step: 99 });
    this.queue.set(printerName, list);
    return id;
  }

  /** Test helper: force the flags of our job (e.g. paper out). */
  setFlags(printerName: string, jobId: number, flags: string[]): void {
    const j = (this.queue.get(printerName) ?? []).find((x) => x.id === jobId);
    if (j) {
      j.flags = flags;
      j.step = 99;
    }
  }

  get queuedCount(): number {
    return [...this.queue.values()].reduce((n, l) => n + l.filter((j) => !j.hidden).length, 0);
  }
}
