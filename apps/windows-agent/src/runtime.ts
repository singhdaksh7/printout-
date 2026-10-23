import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname, release, version as osVersionString } from 'node:os';
import { dirname } from 'node:path';
import { HttpApi } from './api-client.js';
import {
  allowInsecureLoopback, credentialsSchema, dataDir, loadFileConfig, paths, resolveApiBase, saveFileConfig, type FileConfig, type StoredCredentials
} from './config.js';
import { Engine, type EngineConfig } from './engine.js';
import { Journal } from './journal.js';
import { createLogger, type Logger } from './logger.js';
import { DpapiFileStore, restrictToCurrentUser, type SecretStore } from './secure-store.js';
import { WindowsSpooler, type Spooler } from './spooler.js';
import { TempFiles } from './tempfiles.js';

export const AGENT_VERSION = '0.1.0';
export const osDescription = () => `Windows ${release()} (${osVersionString()})`.slice(0, 60);

export interface Runtime {
  dir: string;
  file: FileConfig;
  log: Logger;
  store: SecretStore;
  spooler: Spooler;
  p: ReturnType<typeof paths>;
}

export async function openRuntime(env: NodeJS.ProcessEnv = process.env, overrides: { store?: SecretStore; spooler?: Spooler } = {}): Promise<Runtime> {
  const dir = dataDir(env);
  mkdirSync(dir, { recursive: true });
  await restrictToCurrentUser(dir);
  const p = paths(dir);
  const file = loadFileConfig(p.config);
  const log = createLogger({ level: file.logLevel, file: p.log });
  const store = overrides.store ?? new DpapiFileStore(p.credentials);
  const spooler =
    overrides.spooler ??
    new WindowsSpooler({ pdfRendererPath: file.pdfRenderer?.path, pdfRendererSha256: file.pdfRenderer?.sha256 });
  return { dir, file, log, store, spooler, p };
}

export async function loadCredentials(rt: Runtime): Promise<StoredCredentials | null> {
  const raw = await rt.store.read();
  if (!raw) return null;
  const parsed = credentialsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('The stored credentials are damaged. Pair this computer again.');
  return parsed.data;
}

export async function pairComputer(rt: Runtime, input: { server: string; code: string; name?: string }, env: NodeJS.ProcessEnv = process.env): Promise<StoredCredentials> {
  const apiBase = resolveApiBase(input.server, env);
  const api = new HttpApi({ baseUrl: apiBase, userAgent: `PrintoutBuddyAgent/${AGENT_VERSION}` });
  const deviceName = (input.name ?? hostname()).trim().slice(0, 60) || 'Windows PC';
  const res = await api.pair({ code: input.code, deviceName, appVersion: AGENT_VERSION, osVersion: osDescription() });
  const now = new Date().toISOString();
  const creds: StoredCredentials = {
    apiBase, deviceId: res.deviceId, deviceName, credential: res.deviceCredential, shopName: res.shop.displayName, pairedAt: now, rotatedAt: now
  };
  await rt.store.write(JSON.stringify(creds)); // encrypted with DPAPI; the credential is shown nowhere
  saveFileConfig(rt.p.config, { ...rt.file, apiUrl: apiBase });
  return creds;
}

/** Single-instance guard: two agents would double-claim and double-print. Stale locks (dead pid) are replaced. */
export function acquireLock(lockFile: string): () => void {
  mkdirSync(dirname(lockFile), { recursive: true });
  const tryCreate = () => {
    const fd = openSync(lockFile, 'wx', 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    tryCreate();
  } catch {
    let pid = NaN;
    try {
      pid = Number(readFileSync(lockFile, 'utf8').trim());
    } catch {
      /* unreadable */
    }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) throw new Error('Another Printout Buddy agent is already running on this computer');
    rmSync(lockFile, { force: true });
    tryCreate();
  }
  return () => rmSync(lockFile, { force: true });
}

export function engineConfig(rt: Runtime, creds: StoredCredentials, env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return {
    apiBase: creds.apiBase,
    allowInsecureLoopback: allowInsecureLoopback(env),
    pollIntervalMs: 5_000,
    housekeepingIntervalMs: 5 * 60_000,
    printerReportIntervalMs: 5 * 60_000,
    maxDocumentBytes: Math.floor(rt.file.maxDocumentMB * 1024 * 1024),
    monitorMs: rt.file.monitorSeconds * 1000,
    monitorPollMs: 2_000,
    leaseRenewMs: 30_000,
    appearMs: 15_000,
    downloadAttempts: 3,
    appVersion: AGENT_VERSION,
    osVersion: osDescription()
  };
}

export async function buildEngine(rt: Runtime, creds: StoredCredentials, env: NodeJS.ProcessEnv = process.env) {
  const api = new HttpApi({ baseUrl: creds.apiBase, userAgent: `PrintoutBuddyAgent/${AGENT_VERSION}` });
  api.setCredential(creds.credential);
  const temp = new TempFiles(rt.dir, rt.file.tempRetentionMinutes * 60_000);
  await temp.init();
  const journal = new Journal(rt.p.journal);
  let current = creds;

  const rotate = async () => {
    const res = await api.rotate();
    // Persist the new credential BEFORE using it. If this write fails the old credential still works for the grace period.
    current = { ...current, credential: res.deviceCredential, rotatedAt: new Date().toISOString() };
    await rt.store.write(JSON.stringify(current));
    api.setCredential(res.deviceCredential);
    rt.log.info('device credential rotated', { version: res.credentialVersion });
  };
  const maybeRotate = async () => {
    const ageMs = Date.now() - Date.parse(current.rotatedAt);
    if (ageMs > rt.file.rotateCredentialAfterDays * 86_400_000) await rotate();
  };

  const engine = new Engine({ api, spooler: rt.spooler, journal, temp, log: rt.log, config: engineConfig(rt, creds, env), maybeRotate });
  return { engine, api, rotate, temp, journal, creds: () => current };
}

export const taskInstalledHint = (dir: string) => existsSync(paths(dir).credentials);
