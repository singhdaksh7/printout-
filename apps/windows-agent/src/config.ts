import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { normalizeApiBase } from './api-client.js';

/** Where everything lives: %LOCALAPPDATA%\PrintoutBuddyAgent (override with PRINTOUT_AGENT_HOME). ACL-restricted to the user. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PRINTOUT_AGENT_HOME) return env.PRINTOUT_AGENT_HOME;
  const base = env.LOCALAPPDATA ?? (env.HOME ? join(env.HOME, '.local', 'share') : '.');
  return join(base, 'PrintoutBuddyAgent');
}

export const paths = (dir: string) => ({
  config: join(dir, 'config.json'),
  credentials: join(dir, 'credentials.dpapi'),
  journal: join(dir, 'journal.jsonl'),
  log: join(dir, 'logs', 'agent.log'),
  lock: join(dir, 'agent.lock')
});

const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex SHA-256');

/** Non-secret, human-editable settings. Unknown keys are rejected so typos do not silently disable a safety setting. */
export const fileConfigSchema = z
  .object({
    apiUrl: z.string().min(1).optional(),
    pdfRenderer: z.object({ path: z.string().min(3).max(500), sha256: sha256.optional() }).strict().optional(),
    maxDocumentMB: z.number().min(1).max(100).default(50),
    monitorSeconds: z.number().min(10).max(900).default(120),
    tempRetentionMinutes: z.number().min(1).max(240).default(15),
    rotateCredentialAfterDays: z.number().min(1).max(365).default(30),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info')
  })
  .strict();
export type FileConfig = z.infer<typeof fileConfigSchema>;

export function loadFileConfig(file: string): FileConfig {
  if (!existsSync(file)) return fileConfigSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const parsed = fileConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return parsed.data;
}

export function saveFileConfig(file: string, cfg: FileConfig): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export const allowInsecureLoopback = (env: NodeJS.ProcessEnv = process.env) => env.PRINTOUT_AGENT_ALLOW_INSECURE_LOOPBACK === '1';

export function resolveApiBase(url: string, env: NodeJS.ProcessEnv = process.env): string {
  return normalizeApiBase(url, allowInsecureLoopback(env));
}

/** What is stored (DPAPI-encrypted) after pairing. */
export const credentialsSchema = z.object({
  apiBase: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  credential: z.string().startsWith('pbd_'),
  shopName: z.string(),
  pairedAt: z.string(),
  rotatedAt: z.string()
});
export type StoredCredentials = z.infer<typeof credentialsSchema>;
