import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReportStatus } from './protocol.js';

/**
 * Write-ahead journal (JSON lines, fsynced). It is what makes crashes safe for a physical side effect:
 *   - 'submit-begin' is durable BEFORE the first byte goes to the spooler, together with the ids already queued,
 *     so after a crash the agent can tell "never started" from "may have printed" and find its own spooler job;
 *   - 'report' / 'acked' track status reports the server may not have received (replayed after a restart; the server
 *     treats a repeat of the same status as a no-op).
 * The journal never contains document contents, names or URLs.
 */
export type JournalEvent =
  | { ev: 'claimed'; jobId: string; attempt: number; leaseId: string; printerName: string }
  | { ev: 'submit-begin'; jobId: string; attempt: number; leaseId: string; printerName: string; documentName: string; queuedIds: number[] }
  | { ev: 'submitted'; jobId: string; spoolerJobId: number | null }
  | { ev: 'report'; jobId: string; leaseId: string; status: ReportStatus; spoolerJobId?: number; spoolerState?: string; errorCode?: string; errorMessage?: string }
  | { ev: 'acked'; jobId: string; status: ReportStatus }
  | { ev: 'done'; jobId: string };

export interface JobMemory {
  jobId: string;
  attempt: number;
  leaseId: string;
  printerName: string;
  submitBegun: boolean;
  documentName?: string;
  queuedIds: number[];
  spoolerJobId: number | null;
  /** The most recent report that has not been acknowledged by the server. */
  unacked?: Extract<JournalEvent, { ev: 'report' }>;
  done: boolean;
}

export class Journal {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  append(e: JournalEvent): void {
    const line = JSON.stringify({ t: Date.now(), ...e }) + '\n';
    const fd = openSync(this.file, 'a', 0o600);
    try {
      appendFileSync(fd, line);
      fsyncSync(fd); // durable before the caller proceeds
    } finally {
      closeSync(fd);
    }
  }

  /** Folds the log into per-job memory. Corrupt lines (e.g. a torn last write) are skipped. */
  state(): Map<string, JobMemory> {
    const jobs = new Map<string, JobMemory>();
    if (!existsSync(this.file)) return jobs;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: JournalEvent;
      try {
        e = JSON.parse(line) as JournalEvent;
      } catch {
        continue;
      }
      if (e.ev === 'claimed') {
        jobs.set(e.jobId, { jobId: e.jobId, attempt: e.attempt, leaseId: e.leaseId, printerName: e.printerName, submitBegun: false, queuedIds: [], spoolerJobId: null, done: false });
        continue;
      }
      const m = jobs.get(e.jobId);
      if (!m) continue;
      if (e.ev === 'submit-begin') {
        m.submitBegun = true;
        m.documentName = e.documentName;
        m.queuedIds = e.queuedIds;
        m.attempt = e.attempt;
        m.leaseId = e.leaseId;
      } else if (e.ev === 'submitted') m.spoolerJobId = e.spoolerJobId;
      else if (e.ev === 'report') m.unacked = e;
      else if (e.ev === 'acked') {
        if (m.unacked && m.unacked.status === e.status) delete m.unacked;
      } else if (e.ev === 'done') m.done = true;
    }
    return jobs;
  }

  /** Drops finished jobs so the file stays small. Atomic rewrite. */
  compact(): void {
    const live = [...this.state().values()].filter((m) => !m.done);
    const lines: string[] = [];
    for (const m of live) {
      lines.push(JSON.stringify({ ev: 'claimed', jobId: m.jobId, attempt: m.attempt, leaseId: m.leaseId, printerName: m.printerName }));
      if (m.submitBegun) lines.push(JSON.stringify({ ev: 'submit-begin', jobId: m.jobId, attempt: m.attempt, leaseId: m.leaseId, printerName: m.printerName, documentName: m.documentName, queuedIds: m.queuedIds }));
      if (m.spoolerJobId !== null) lines.push(JSON.stringify({ ev: 'submitted', jobId: m.jobId, spoolerJobId: m.spoolerJobId }));
      if (m.unacked) lines.push(JSON.stringify(m.unacked));
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, lines.map((l) => l + '\n').join(''), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
