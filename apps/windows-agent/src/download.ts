import { createHash } from 'node:crypto';
import { createWriteStream, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ValidationError } from './validate.js';

export interface DownloadResult {
  size: number;
  sha256: string;
}

/**
 * Streams a document to `destPath` (created exclusively). Hard limits:
 *  - redirects are refused (a signed URL must answer directly);
 *  - the byte count is enforced while streaming, not only from Content-Length;
 *  - a declared size from the server must match, and a 64-hex checksum is verified when provided.
 * The URL (a bearer capability) is never logged and never leaves this function.
 */
export async function downloadToFile(
  url: URL,
  destPath: string,
  opts: { maxBytes: number; expectedSize: number | null; expectedSha256: string | null; timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<DownloadResult> {
  const res = await (opts.fetchImpl ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000), headers: { accept: '*/*' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > opts.maxBytes) throw new ValidationError('TOO_LARGE', 'The document exceeds the size limit');
  const hash = createHash('sha256');
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > opts.maxBytes) return cb(new ValidationError('TOO_LARGE', 'The document exceeds the size limit'));
      hash.update(chunk);
      cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body as never), limiter, createWriteStream(destPath, { flags: 'wx', mode: 0o600 }));
  if (opts.expectedSize !== null && size !== opts.expectedSize) throw new ValidationError('MALFORMED', 'The downloaded size does not match the document');
  const digest = hash.digest('hex');
  if (opts.expectedSha256 && /^[0-9a-f]{64}$/i.test(opts.expectedSha256) && digest !== opts.expectedSha256.toLowerCase()) {
    throw new ValidationError('CHECKSUM_MISMATCH', 'The downloaded document failed its integrity check');
  }
  return { size, sha256: digest };
}

/** Reads the first and last `n` bytes of a file for validation without loading it. */
export function readEnds(path: string, n = 2048): { head: Uint8Array; tail: Uint8Array; size: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(n, size));
    readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(n, size));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    return { head, tail, size };
  } finally {
    closeSync(fd);
  }
}
