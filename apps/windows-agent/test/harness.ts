import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, type AgentApi } from '../src/api-client.js';
import { Engine, type EngineConfig } from '../src/engine.js';
import { Journal } from '../src/journal.js';
import { silentLogger } from '../src/logger.js';
import type { Spooler } from '../src/spooler.js';
import { TempFiles } from '../src/tempfiles.js';
import { FakeApi, type FakeJob } from '../src/testing/fake-api.js';
import { FakeSpooler } from '../src/testing/fake-spooler.js';

export class Crash extends Error {}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
export const ENCRYPTED_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<</Root 1 0 R/Encrypt 2 0 R>>\n%%EOF\n');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

/** Serves documents by job id: GET /<jobId>. `fail` makes the next N requests drop. */
export class DocServer {
  server!: Server;
  docs = new Map<string, Buffer>();
  failNext = 0;
  hits = 0;
  port = 0;
  async start() {
    this.server = createServer((req, res) => {
      this.hits++;
      if (this.failNext > 0) {
        this.failNext--;
        req.socket.destroy();
        return;
      }
      const id = (req.url ?? '').split('?')[0]!.slice(1);
      const doc = this.docs.get(id);
      if (!doc) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(doc.length) }).end(doc);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
  }
  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export const baseConfig = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  apiBase: 'http://127.0.0.1:1/api/v1',
  allowInsecureLoopback: true,
  pollIntervalMs: 1,
  housekeepingIntervalMs: 1_000_000,
  printerReportIntervalMs: 300_000,
  maxDocumentBytes: 1024 * 1024,
  monitorMs: 60_000,
  monitorPollMs: 1_000,
  leaseRenewMs: 1_000,
  appearMs: 3_000,
  downloadAttempts: 3,
  appVersion: '0.1.0-test',
  osVersion: 'Windows test',
  ...over
});

/** Wraps an object so that every method call throws Crash once `kill()` was called: a process that died mid-flight. */
function mortal<T extends object>(target: T, world: { dead: boolean }): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        if (world.dead) throw new Crash('process is dead');
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    }
  });
}

export interface Rig {
  api: FakeApi;
  spooler: FakeSpooler;
  docs: DocServer;
  dir: string;
  temp: TempFiles;
  journal: Journal;
  world: { dead: boolean };
  clock: { t: number };
  newEngine(over?: Partial<EngineConfig>): Engine;
  job(over?: Partial<FakeJob>, doc?: Buffer, mime?: string): FakeJob;
  kill(): void;
  revive(): void;
  cleanup(): Promise<void>;
}

export async function makeRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'pb-agent-test-'));
  const docs = new DocServer();
  await docs.start();
  const api = new FakeApi();
  api.downloadUrl = `http://127.0.0.1:${docs.port}`;
  const spooler = new FakeSpooler();
  const temp = new TempFiles(dir, 15 * 60_000);
  await temp.init();
  const journal = new Journal(join(dir, 'journal.jsonl'));
  const world = { dead: false };
  const clock = { t: 1_000_000 };
  const rig: Rig = {
    api, spooler, docs, dir, temp, journal, world, clock,
    newEngine(over = {}) {
      return new Engine({
        api: mortal(api as AgentApi, world),
        spooler: mortal(spooler as Spooler, world),
        journal: mortal(journal, world),
        temp,
        log: silentLogger,
        config: baseConfig({ apiBase: `http://127.0.0.1:${docs.port}/api/v1`, ...over }),
        sleep: async (ms) => {
          clock.t += ms;
        },
        now: () => clock.t
      });
    },
    job(over = {}, doc = PDF, mime = 'application/pdf') {
      const j = api.addJob({ document: { mime, bytes: doc }, ...over });
      docs.docs.set(j.id, doc);
      return j;
    },
    kill: () => {
      world.dead = true;
    },
    revive: () => {
      world.dead = false;
    },
    async cleanup() {
      await docs.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return rig;
}

export const networkError = () => new ApiError(0, 'NETWORK', 'down', true);
