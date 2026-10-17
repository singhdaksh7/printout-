import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Structured logger. Rules (enforced by redact() and by never passing such values in):
 *  - never a credential, never a document's contents, never a signed URL (query strings are stripped).
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value: string): string {
  return value
    .replace(/pbd_[A-Za-z0-9_-]{8,}/g, 'pbd_[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/[^\s"'?#]+)\?[^\s"']*/g, '$1?[redacted]')
    .replace(/\b[A-Z]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '[pairing-code]');
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function createLogger(opts: { level?: Level; file?: string; stderr?: boolean } = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const write = (level: Level, msg: string, ctx?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const line = redact(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(ctx ?? {}) }));
    if (opts.stderr !== false) process.stderr.write(line + '\n');
    if (opts.file) {
      try {
        mkdirSync(dirname(opts.file), { recursive: true });
        try {
          if (statSync(opts.file).size > MAX_LOG_BYTES) renameSync(opts.file, opts.file + '.1');
        } catch {
          /* no file yet */
        }
        appendFileSync(opts.file, line + '\n', { mode: 0o600 });
      } catch {
        /* logging must never crash the agent */
      }
    }
  };
  return {
    debug: (m, c) => write('debug', m, c),
    info: (m, c) => write('info', m, c),
    warn: (m, c) => write('warn', m, c),
    error: (m, c) => write('error', m, c)
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
