import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConfigError, loadConfig } from './config.js';
import { cleanupExpiredDocuments, cleanupPairingCodes, type CleanupLogger, type CleanupResult, type CleanupStorage } from './cleanup.js';
import { createStorage, type StorageConfig } from './storage/index.js';

/**
 * Retention worker process: periodically deletes expired documents (see cleanup.ts).
 *
 * Limitation: this is a separate OS process from the API, so the in-memory SSE hub
 * (ShopEvents) is not reachable from here. `document.deleted` / `order.statusChanged`
 * events emitted by cleanup are therefore NOT pushed to shop browsers; the UI relies on
 * the server-provided `deleteAfter` countdown and refetching.
 */

// Read locally so the worker works even if config.ts does not define the key yet.
const workerEnvSchema = z.object({
  DOCUMENT_CLEANUP_INTERVAL_MINUTES: z.coerce.number().positive().default(1),
  DOCUMENT_CLEANUP_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  DOCUMENT_STALE_UPLOAD_MINUTES: z.coerce.number().positive().default(60),
  WORKER_RUN_ONCE: z.string().optional()
});

export interface WorkerOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  prisma?: PrismaClient;
  storage?: CleanupStorage;
  log?: CleanupLogger;
  /** Overrides the computed interval (ms); used by tests. */
  intervalMs?: number;
  /** Run exactly one cleanup then stop. Also enabled by `--once` or WORKER_RUN_ONCE=1. */
  once?: boolean;
  /** Injected clock for tests. */
  now?: () => Date;
}

export interface WorkerHandle {
  /** Resolves when the worker has stopped (after `--once`, or after `stop()`). */
  done: Promise<void>;
  /** Graceful stop: lets the in-flight batch finish, then disconnects Prisma if the worker created it. */
  stop(): Promise<void>;
  /** Results of every completed run (last one last). */
  runs: CleanupResult[];
}

const PAIRING_SWEEP_INTERVAL_MS = 60 * 60_000;

const consoleLogger: CleanupLogger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj }))
};

export function startWorker(options: WorkerOptions = {}): WorkerHandle {
  const env = options.env ?? process.env;
  const settings = workerEnvSchema.parse(env);
  const log = options.log ?? consoleLogger;
  const ownsPrisma = !options.prisma;
  const prisma = options.prisma ?? new PrismaClient();
  const storage: CleanupStorage = options.storage ?? createWorkerStorage(env);
  const once = options.once ?? (options.argv ?? process.argv).includes('--once');
  const runOnce = once || settings.WORKER_RUN_ONCE === '1';
  const intervalMs = options.intervalMs ?? Math.round(settings.DOCUMENT_CLEANUP_INTERVAL_MINUTES * 60_000);

  const runs: CleanupResult[] = [];
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let lastPairingSweepAt = 0;

  log.info?.({ intervalMs, runOnce, batchSize: settings.DOCUMENT_CLEANUP_BATCH_SIZE }, 'retention worker started');

  // Runs are strictly sequential: the next tick is scheduled only after the previous run finished.
  const tick = async () => {
    try {
      const result = await cleanupExpiredDocuments(prisma, storage, {
        now: options.now?.() ?? new Date(),
        batchSize: settings.DOCUMENT_CLEANUP_BATCH_SIZE,
        staleUploadMinutes: settings.DOCUMENT_STALE_UPLOAD_MINUTES,
        log
      });
      runs.push(result);
    } catch (error) {
      // Crash-safe: a failed run (e.g. DB down) is logged and retried on the next tick.
      log.error?.({ err: error instanceof Error ? error.name : 'unknown' }, 'document cleanup run failed');
    }
    // Housekeeping AFTER document cleanup, hourly at most, in its own try/catch: it can never delay or break document deletion.
    const nowMs = (options.now?.() ?? new Date()).getTime();
    if (nowMs - lastPairingSweepAt >= PAIRING_SWEEP_INTERVAL_MS) {
      try {
        const swept = await cleanupPairingCodes(prisma, { now: new Date(nowMs) });
        lastPairingSweepAt = nowMs;
        if (swept.deleted > 0) log.info?.({ deleted: swept.deleted }, 'pairing code sweep finished');
      } catch (error) {
        log.error?.({ err: error instanceof Error ? error.name : 'unknown' }, 'pairing code sweep failed');
      }
    }
  };

  const done = (async () => {
    do {
      running = tick();
      await running;
      if (runOnce || stopping) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalMs);
      });
    } while (!stopping);
    clearTimeout(timer);
    if (ownsPrisma) await prisma.$disconnect();
    log.info?.({ runs: runs.length }, 'retention worker stopped');
  })();

  return {
    runs,
    done,
    async stop() {
      stopping = true;
      clearTimeout(timer);
      wake?.();
      await done;
    }
  };
}

/** Builds the storage driver. Raw env is merged in so S3_* keys survive loadConfig's zod stripping. */
function createWorkerStorage(env: NodeJS.ProcessEnv): CleanupStorage {
  const config = loadConfig(env);
  return createStorage({ ...(env as Record<string, string>), ...config } as unknown as StorageConfig);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Same validation as the API (production fails closed): print every problem, never secret values, and exit non-zero.
  try {
    loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : 'Invalid configuration');
    process.exit(1);
  }
  const handle = startWorker();
  const shutdown = () => {
    void handle.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled rejection', err: reason instanceof Error ? reason.name : 'unknown' }));
  });
  void handle.done.then(() => process.exit(0));
}
