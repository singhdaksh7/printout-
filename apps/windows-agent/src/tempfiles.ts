import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { SupportedMime } from './protocol.js';
import { restrictToCurrentUser } from './secure-store.js';

/**
 * Temporary document files.
 *  - live under <dataDir>/temp (ACL-restricted to the current user), each job in its own random directory;
 *  - the file name is derived from validated parts only (job id pattern + attempt + a fixed extension per MIME type);
 *    nothing from the server's file name is ever used in a path (no traversal);
 *  - created exclusively ('wx'), removed after use, and swept on start and periodically (max retention).
 */
const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EXT: Record<SupportedMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

export interface TempHandle {
  dir: string;
  filePath: string;
  cleanup(): void;
}

export class TempFiles {
  readonly root: string;
  constructor(dataDir: string, private readonly maxAgeMs: number) {
    this.root = resolve(dataDir, 'temp');
  }

  async init(): Promise<void> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    await restrictToCurrentUser(this.root);
  }

  /** Base name used as the spooler document name: pb-<jobId>-<attempt>. */
  static documentName(jobId: string, attempt: number): string {
    if (!JOB_ID_RE.test(jobId) || !Number.isInteger(attempt) || attempt < 0 || attempt > 1000) throw new Error('Invalid job identifier');
    return `pb-${jobId}-${attempt}`;
  }

  allocate(jobId: string, attempt: number, mime: SupportedMime): TempHandle {
    const name = TempFiles.documentName(jobId, attempt);
    const dir = join(this.root, randomBytes(12).toString('hex'));
    mkdirSync(dir, { mode: 0o700 });
    const filePath = join(dir, `${name}.${EXT[mime]}`);
    // Defence in depth: the resolved path must stay inside the temp root.
    if (!resolve(filePath).startsWith(this.root + sep)) throw new Error('Path escapes the temp directory');
    return { dir, filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** Removes job directories older than the retention limit (crash leftovers). Returns the number removed. */
  sweep(now = Date.now()): number {
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(this.root);
    } catch {
      return 0;
    }
    for (const e of entries) {
      const p = join(this.root, e);
      try {
        if (now - statSync(p).mtimeMs > this.maxAgeMs) {
          rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* concurrently removed */
      }
    }
    return removed;
  }

  count(): number {
    try {
      return readdirSync(this.root).length;
    } catch {
      return 0;
    }
  }
}
