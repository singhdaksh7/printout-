import { createHash } from 'node:crypto';
import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api-client.js';
import { Crash, ENCRYPTED_PDF, JPEG, makeRig, networkError, PDF, PNG, type Rig } from './harness.js';

/**
 * Engine behaviour against the in-memory API and the virtual printer.
 * The recurring assertion is `spooler.submissions` : a physical side effect must happen AT MOST once per job.
 */
describe('print engine', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await makeRig();
  });
  afterEach(() => rig.cleanup());

  const run = async (n = 1) => {
    const e = rig.newEngine();
    for (let i = 0; i < n; i++) {
      try {
        await e.tick();
      } catch (err) {
        if (!(err instanceof Crash)) throw err; // a simulated process death: the test continues with a fresh engine
      }
    }
    return e;
  };
  const tempEmpty = () => readdirSync(rig.temp.root).length === 0;

  describe('happy path', () => {
    it('PDF: claim -> download -> validate -> submit -> PRINT_INITIATED, never "printed"; temp file removed', async () => {
      const j = rig.job({ options: { copies: 2, colourMode: 'bw', sides: 'duplex', paperSize: 'A4', pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 2 }, { from: 4, to: 4 }] } } });
      await run();
      expect(j.status).toBe('PRINT_INITIATED');
      expect(j.spoolerJobId).not.toBeNull();
      expect(rig.spooler.submissions).toHaveLength(1);
      const s = rig.spooler.submissions[0]!;
      expect(s.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
      expect(s.documentName).toBe(`pb-${j.id}-1`);
      expect(s.options.copies).toBe(2);
      expect(tempEmpty()).toBe(true);
      expect(rig.api.jobs.map((x) => x.status as string)).not.toContain('PRINTED');
    });

    it('PNG and JPEG images print too', async () => {
      const a = rig.job({}, PNG, 'image/png');
      await run();
      expect(a.status).toBe('PRINT_INITIATED');
      const b = rig.job({}, JPEG, 'image/jpeg');
      await run();
      expect(b.status).toBe('PRINT_INITIATED');
      expect(rig.spooler.submissions.map((s) => s.mime)).toEqual(['image/png', 'image/jpeg']);
    });

    it('a job that already left the queue before it could be observed is PRINT_INITIATED with that honest note', async () => {
      rig.spooler.behaviour = 'instant';
      const j = rig.job();
      await run();
      expect(j.status).toBe('PRINT_INITIATED');
      expect(j.spoolerState).toBe('left-queue-before-observed');
      expect(rig.spooler.submissions).toHaveLength(1);
    });

    it('one job at a time and in order; the second job waits for the next tick', async () => {
      const a = rig.job();
      const b = rig.job();
      const e = rig.newEngine();
      await e.tick();
      expect(a.status).toBe('PRINT_INITIATED');
      expect(b.status).toBe('QUEUED');
      await e.tick();
      expect(b.status).toBe('PRINT_INITIATED');
    });

    it('reports printers and heartbeats', async () => {
      await run();
      expect(rig.api.heartbeats).toBe(1);
      expect(rig.api.printerReports[0]![0]).toMatchObject({ name: 'Front Desk LaserJet', supportsDuplex: true });
    });
  });

  describe('document validation: unsupported input fails safely BEFORE the spooler', () => {
    const cases: Array<[string, Buffer, string, string, Partial<{ declaredSize: number | null }>?]> = [
      ['an unsupported type', Buffer.from('hello'), 'text/plain', 'UNSUPPORTED_TYPE'],
      ['an executable declared as PDF', Buffer.from('MZ\x90\x00 fake exe'), 'application/pdf', 'MALFORMED'],
      ['a PNG declared as PDF', PNG, 'application/pdf', 'TYPE_MISMATCH'],
      ['a password-protected PDF', ENCRYPTED_PDF, 'application/pdf', 'ENCRYPTED_PDF'],
      ['a truncated PDF', Buffer.from('%PDF-1.4\n1 0 obj'), 'application/pdf', 'MALFORMED'],
      ['an empty file', Buffer.alloc(0), 'application/pdf', 'EMPTY']
    ];
    for (const [name, bytes, mime, code] of cases) {
      it(`${name} -> FAILED ${code}, nothing submitted, no temp files`, async () => {
        const j = rig.job({ document: { mime, bytes } }, bytes, mime);
        await run();
        expect(j.status).toBe('FAILED');
        expect(j.errorCode).toBe(code);
        expect(j.submittingAt).toBeNull(); // retry-safe: the server never saw SUBMITTING
        expect(rig.spooler.submissions).toHaveLength(0);
        expect(tempEmpty()).toBe(true);
      });
    }

    it('a document over the size limit is refused while streaming', async () => {
      const big = Buffer.concat([PDF.subarray(0, PDF.length - 6), Buffer.alloc(2 * 1024 * 1024), Buffer.from('\n%%EOF\n')]);
      const j = rig.job({ document: { mime: 'application/pdf', bytes: big, declaredSize: null, declaredSha256: null } }, big);
      await run();
      expect(j).toMatchObject({ status: 'FAILED', errorCode: 'TOO_LARGE' });
      expect(rig.spooler.submissions).toHaveLength(0);
      expect(tempEmpty()).toBe(true);
    });

    it('a checksum mismatch (tampered download) is refused', async () => {
      const j = rig.job({ document: { mime: 'application/pdf', bytes: PDF, declaredSha256: 'a'.repeat(64) } });
      await run();
      expect(j).toMatchObject({ status: 'FAILED', errorCode: 'CHECKSUM_MISMATCH' });
      expect(rig.spooler.submissions).toHaveLength(0);
    });

    it('PDF without a renderer fails as RENDERER_MISSING, before SUBMITTING (retry-safe); images still work', async () => {
      rig.spooler.pdfRenderer = false;
      const pdf = rig.job();
      const img = rig.job({}, PNG, 'image/png');
      const e = rig.newEngine();
      await e.tick();
      expect(pdf).toMatchObject({ status: 'FAILED', errorCode: 'RENDERER_MISSING', submittingAt: null });
      await e.tick();
      expect(img.status).toBe('PRINT_INITIATED');
      expect(rig.spooler.submissions).toHaveLength(1);
    });
  });

  describe('printer checks', () => {
    it('an offline printer is refused up front (it would otherwise print hours later)', async () => {
      rig.spooler.printers[0]!.connectivity = 'OFFLINE';
      const j = rig.job();
      await run();
      expect(j).toMatchObject({ status: 'FAILED', errorCode: 'PRINTER_OFFLINE', submittingAt: null });
      expect(rig.spooler.submissions).toHaveLength(0);
    });
    it('an uninstalled printer, or an option the printer lacks, fails before submission', async () => {
      const a = rig.job({ printerName: 'Ghost' });
      const b = rig.job({ options: { copies: 1, colourMode: 'colour', sides: 'single', paperSize: 'A4', pageSelection: { mode: 'all' } } });
      const e = rig.newEngine();
      await e.tick();
      await e.tick();
      expect(a.errorCode).toBe('PRINTER_NOT_FOUND');
      expect(b.errorCode).toBe('UNSUPPORTED_OPTIONS');
      expect(rig.spooler.submissions).toHaveLength(0);
    });
  });

  describe('spooler outcomes (never claims paper)', () => {
    it('renderer error AFTER the job was queued: tracked, not hidden, not resubmitted', async () => {
      rig.spooler.behaviour = 'error-after-queue';
      const j = rig.job();
      await run();
      expect(j.status).toBe('PRINT_INITIATED');
      expect(rig.spooler.submissions).toHaveLength(1);
    });

    it('renderer error with nothing queued: FAILED with duplicate risk (submittingAt set) - a human decides', async () => {
      rig.spooler.behaviour = 'error-nothing-queued';
      const j = rig.job();
      await run();
      expect(j).toMatchObject({ status: 'FAILED', errorCode: 'RENDERER_EXIT' });
      expect(j.submittingAt).not.toBeNull();
      expect(rig.spooler.submissions).toHaveLength(1);
    });

    it('spooler error flags that never clear -> NEEDS_RECONCILIATION (the job may still print later)', async () => {
      rig.spooler.lifecycle = [['Spooling'], ['Error', 'PaperOut']];
      const j = rig.job();
      await run();
      expect(j).toMatchObject({ status: 'NEEDS_RECONCILIATION', errorCode: 'SPOOLER_ERROR' });
      expect(rig.spooler.queuedCount).toBe(1); // we do not delete the user's job on our own
    });

    it('a job someone deleted from the queue -> NEEDS_RECONCILIATION', async () => {
      rig.spooler.lifecycle = [['Spooling'], ['Deleting']];
      const j = rig.job();
      await run();
      expect(j).toMatchObject({ status: 'NEEDS_RECONCILIATION', errorCode: 'SPOOLER_JOB_DELETED' });
    });

    it('two unknown jobs appearing at once -> NEEDS_RECONCILIATION (never guess which one is ours)', async () => {
      rig.spooler.opaqueNames = true;
      rig.spooler.onSubmitStart = () => {
        rig.spooler.addForeignJob('Front Desk LaserJet');
        rig.spooler.addForeignJob('Front Desk LaserJet');
      };
      const j = rig.job();
      await run();
      expect(j).toMatchObject({ status: 'NEEDS_RECONCILIATION', errorCode: 'SPOOLER_JOB_AMBIGUOUS' });
    });

    it('a foreign job already in the queue does not confuse tracking', async () => {
      const foreign = rig.spooler.addForeignJob('Front Desk LaserJet');
      const j = rig.job();
      await run();
      expect(j.status).toBe('PRINT_INITIATED');
      expect(j.spoolerJobId).not.toBe(foreign);
    });
  });

  describe('download resilience', () => {
    it('retries a dropped download and still prints exactly once', async () => {
      rig.docs.failNext = 2;
      const j = rig.job();
      await run();
      expect(j.status).toBe('PRINT_INITIATED');
      expect(rig.docs.hits).toBe(3);
      expect(rig.spooler.submissions).toHaveLength(1);
    });
    it('gives up after the attempt budget with DOWNLOAD_FAILED, retry-safe', async () => {
      rig.docs.failNext = 10;
      const j = rig.job();
      await run();
      expect(j).toMatchObject({ status: 'FAILED', errorCode: 'DOWNLOAD_FAILED', submittingAt: null });
      expect(rig.spooler.submissions).toHaveLength(0);
      expect(tempEmpty()).toBe(true);
    });
    it('a download URL that is not https (outside loopback dev mode) is refused', async () => {
      rig.api.downloadUrl = 'http://evil.example.com';
      const j = rig.job();
      const e = rig.newEngine({ allowInsecureLoopback: false });
      await e.tick();
      expect(j.status).not.toBe('PRINT_INITIATED');
      expect(rig.spooler.submissions).toHaveLength(0);
    });
  });

  describe('cancel', () => {
    it('cancel before submission: the agent stops and confirms CANCELED; nothing printed', async () => {
      const j = rig.job();
      rig.api.hooks.afterProgress = (_id, r) => {
        if (r.status === 'DOWNLOADING') rig.api.shopCancel(j.id);
      };
      await run();
      expect(j.status).toBe('CANCELED');
      expect(rig.spooler.submissions).toHaveLength(0);
      expect(tempEmpty()).toBe(true);
    });

    it('cancel while the job sits in the spooler: removed and only then CANCELED', async () => {
      rig.spooler.lifecycle = [['Spooling'], ['Spooling'], ['Spooling'], ['Spooling']];
      const j = rig.job();
      rig.api.hooks.afterProgress = (_id, r) => {
        if (r.status === 'SUBMITTED_TO_SPOOLER' && r.spoolerJobId !== undefined) rig.api.shopCancel(j.id);
      };
      const e = rig.newEngine({ monitorMs: 3_000 });
      await e.tick(); // SUBMITTED then the cancel arrives; monitoring ends
      rig.api.hooks.afterProgress = undefined;
      await e.tick(); // the next claim resumes the CANCEL_REQUESTED job
      expect(j.status).toBe('CANCELED');
      expect(rig.spooler.queuedCount).toBe(0);
      expect(rig.spooler.submissions).toHaveLength(1);
    });

    it('cancel when the spooler job cannot be removed: honest PRINT_INITIATED (cancel too late), not CANCELED', async () => {
      rig.spooler.removeSucceeds = false;
      rig.spooler.lifecycle = [['Spooling'], ['Spooling'], ['Spooling'], ['Spooling']];
      const j = rig.job();
      rig.api.hooks.afterProgress = (_id, r) => {
        if (r.status === 'SUBMITTED_TO_SPOOLER' && r.spoolerJobId !== undefined) rig.api.shopCancel(j.id);
      };
      const e = rig.newEngine({ monitorMs: 3_000 });
      await e.tick();
      rig.api.hooks.afterProgress = undefined;
      await e.tick();
      expect(j).toMatchObject({ status: 'PRINT_INITIATED', spoolerState: 'cancel-failed' });
    });
  });

  describe('crash recovery: a physical side effect is never repeated', () => {
    const resume = async () => {
      rig.revive();
      const e2 = rig.newEngine();
      await e2.recover();
      await e2.tick();
      return e2;
    };
    const killOn = (status: string, when: 'before' | 'after') => {
      const key = when === 'before' ? 'beforeProgress' : 'afterProgress';
      rig.api.hooks[key] = (_id, r) => {
        if (r.status === status) {
          rig.kill();
          throw new Crash('boom');
        }
      };
    };

    it('crash after the server acknowledged SUBMITTING but before the journal: nothing was sent -> FAILED RESTARTED_BEFORE_SUBMIT', async () => {
      const j = rig.job();
      killOn('SUBMITTING', 'after');
      await run();
      expect(j.status).toBe('SUBMITTING');
      rig.api.hooks.afterProgress = undefined;
      await resume();
      expect(j).toMatchObject({ status: 'FAILED', errorCode: 'RESTARTED_BEFORE_SUBMIT' });
      expect(rig.spooler.submissions).toHaveLength(0);
    });

    it('crash after the journal but before the spooler was touched: unknown -> NEEDS_RECONCILIATION, and NO resubmission', async () => {
      const j = rig.job();
      rig.spooler.onSubmitStart = () => {
        rig.kill();
        throw new Crash('boom');
      };
      await run();
      rig.spooler.onSubmitStart = undefined;
      await resume();
      expect(j).toMatchObject({ status: 'NEEDS_RECONCILIATION', errorCode: 'OUTCOME_UNKNOWN' });
      expect(rig.spooler.submissions).toHaveLength(0);
      expect(rig.spooler.queuedCount).toBe(0);
    });

    it('crash right after the job entered the spooler: the restarted agent FINDS it, tracks it, and does not resubmit', async () => {
      const j = rig.job();
      rig.spooler.onQueued = () => {
        rig.kill();
        throw new Crash('boom');
      };
      await run();
      expect(j.status).toBe('SUBMITTING');
      rig.spooler.onQueued = undefined;
      await resume();
      expect(j.status).toBe('PRINT_INITIATED');
      expect(rig.spooler.submissions).toHaveLength(1);
    });

    it('crash after the spooler finished but the PRINT_INITIATED report was lost in transit: replayed, idempotent, no resubmission', async () => {
      const j = rig.job();
      killOn('PRINT_INITIATED', 'before'); // the process dies before the server hears it
      await run();
      expect(j.status).toBe('SUBMITTED_TO_SPOOLER');
      rig.api.hooks.beforeProgress = undefined;
      await resume();
      expect(j.status).toBe('PRINT_INITIATED');
      expect(rig.spooler.submissions).toHaveLength(1);
    });

    it('server applied the report but the response was lost: the replay is a no-op and the job stays correct', async () => {
      const j = rig.job();
      killOn('PRINT_INITIATED', 'after');
      await run();
      expect(j.status).toBe('PRINT_INITIATED');
      rig.api.hooks.afterProgress = undefined;
      await resume();
      expect(j.status).toBe('PRINT_INITIATED');
      expect(rig.spooler.submissions).toHaveLength(1);
    });

    it('ambiguous job (server says NEEDS_RECONCILIATION) that the restarted agent finds in the spooler: evidence is attached', async () => {
      const j = rig.job();
      rig.spooler.onQueued = () => {
        rig.kill();
        throw new Crash('boom');
      };
      await run();
      rig.spooler.onQueued = undefined;
      j.status = 'NEEDS_RECONCILIATION'; // the server's lease sweep ran while the agent was down
      rig.revive();
      const e2 = rig.newEngine();
      await e2.recover();
      expect(j.status).toBe('SUBMITTED_TO_SPOOLER');
      expect(j.spoolerJobId).not.toBeNull();
      expect(rig.spooler.submissions).toHaveLength(1);
    });
  });

  describe('reconnect and revocation', () => {
    it('survives network outages and carries on afterwards', async () => {
      const j = rig.job();
      const e = rig.newEngine();
      rig.api.failWith = networkError();
      await expect(e.tick()).rejects.toBeInstanceOf(ApiError);
      await expect(e.tick()).rejects.toBeInstanceOf(ApiError);
      rig.api.failWith = null;
      await e.tick();
      expect(j.status).toBe('PRINT_INITIATED');
    });

    it('run() backs off on outages and returns "revoked" on a 401, without printing anything', async () => {
      const j = rig.job();
      const e = rig.newEngine();
      let calls = 0;
      const original = rig.api.heartbeat.bind(rig.api);
      rig.api.heartbeat = async () => {
        calls++;
        if (calls === 1) throw networkError();
        throw new ApiError(401, 'DEVICE_REVOKED', 'revoked', false);
      };
      const reason = await e.run();
      expect(reason).toBe('revoked');
      expect(calls).toBe(2);
      expect(j.status).toBe('QUEUED');
      expect(rig.spooler.submissions).toHaveLength(0);
      rig.api.heartbeat = original;
    });

    it('an undeliverable SUBMITTING acknowledgement means the agent does NOT print', async () => {
      const j = rig.job();
      rig.api.hooks.beforeProgress = (_id, r) => {
        if (r.status === 'SUBMITTING') throw networkError();
      };
      await run();
      expect(rig.spooler.submissions).toHaveLength(0);
      expect(j.status).toBe('DOWNLOADING');
    });
  });

  describe('temp files', () => {
    it('sweep removes leftovers older than the retention limit and keeps fresh ones', () => {
      const old = join(rig.temp.root, 'olddir');
      const fresh = join(rig.temp.root, 'freshdir');
      for (const d of [old, fresh]) {
        rig.temp.allocate('job0000000001', 1, 'application/pdf');
      }
      const dirs = readdirSync(rig.temp.root);
      const t = (Date.now() - 3600_000) / 1000;
      utimesSync(join(rig.temp.root, dirs[0]!), t, t);
      expect(rig.temp.sweep()).toBe(1);
      expect(readdirSync(rig.temp.root)).toHaveLength(dirs.length - 1);
      void old; void fresh;
    });
    it('refuses a job id that could escape the temp directory', () => {
      expect(() => rig.temp.allocate('../../evil', 1, 'application/pdf')).toThrow();
      expect(() => rig.temp.allocate('a/b/c/d/e/f/g', 1, 'application/pdf')).toThrow();
      expect(existsSync(join(rig.temp.root, '..', 'evil'))).toBe(false);
    });
  });
});
