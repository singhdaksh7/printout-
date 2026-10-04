import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { AppError } from '../errors.js';
import { signatureMime, type Storage } from '../storage/index.js';

/**
 * PDF / image inspection.
 *
 * PDF parser: pdf-lib. It parses classic xref tables, cross-reference streams and object streams, reports
 * encryption deterministically (EncryptedPDFError when ignoreEncryption=false), and is pure JS (no native deps).
 * Trade-off: it needs the whole file in memory (<= UPLOAD_MAX_BYTES, 50 MB default, roughly 3-5x that while parsing),
 * and parsing is synchronous, so it runs inside a worker thread with a heap limit and a hard wall-clock timeout that
 * terminates the thread. The HTTP receive path never buffers; only /complete does, once, after the file is in storage.
 */

export const IMAGE_MAX_DIMENSION = 20_000;
export const IMAGE_MAX_PIXELS = 100_000_000;
const HEAD_BYTES = 1024 * 1024;
const PDF_BUFFER_HARD_CAP = 100 * 1024 * 1024;

export interface InspectResult {
  mime: 'application/pdf' | 'image/jpeg' | 'image/png';
  pageCount: number;
}
export interface InspectPdfOptions {
  maxPages?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

const invalidPdf = (msg = 'The PDF is invalid or corrupted') => new AppError(422, 'INVALID_PDF', msg);

async function collect(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
    total += b.length;
    if (total > limit) throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const lib = require(workerData.pdfLib);
(async () => {
  try {
    const doc = await lib.PDFDocument.load(new Uint8Array(workerData.buf), { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
    parentPort.postMessage({ ok: true, pages: doc.getPageCount() });
  } catch (e) {
    const encrypted = (lib.EncryptedPDFError && e instanceof lib.EncryptedPDFError) || /encrypt/i.test(String(e && e.message));
    parentPort.postMessage({ ok: false, encrypted });
  }
})();
`;
const pdfLibPath = createRequire(import.meta.url).resolve('pdf-lib');

function parseInWorker(buf: Buffer, timeoutMs: number): Promise<{ ok: true; pages: number } | { ok: false; encrypted: boolean }> {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(buf.length);
    copy.set(buf);
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { buf: copy.buffer, pdfLib: pdfLibPath },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 }
    });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(invalidPdf('The PDF took too long to process'))), timeoutMs);
    worker.once('message', (m) => finish(() => resolve(m)));
    worker.once('error', () => finish(() => reject(invalidPdf())));
    worker.once('exit', () => finish(() => reject(invalidPdf())));
  });
}

/** Inspect a PDF held in memory. Throws AppError(INVALID_PDF | PASSWORD_PROTECTED_PDF | PDF_TOO_MANY_PAGES). */
export async function inspectPdfBuffer(buf: Buffer, opts: InspectPdfOptions = {}): Promise<{ pageCount: number }> {
  if (buf.length === 0) throw new AppError(422, 'EMPTY_FILE', 'The file is empty');
  if (buf.length < 16 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw invalidPdf();
  if (!buf.subarray(Math.max(0, buf.length - 2048)).includes('%%EOF')) throw invalidPdf('The PDF appears to be truncated');
  const result = await parseInWorker(buf, opts.timeoutMs ?? 20_000);
  if (!result.ok) {
    if (result.encrypted) throw new AppError(422, 'PASSWORD_PROTECTED_PDF', 'Password-protected PDFs are not supported');
    throw invalidPdf();
  }
  if (result.pages < 1) throw invalidPdf('The PDF has no pages');
  if (opts.maxPages !== undefined && result.pages > opts.maxPages) {
    throw new AppError(422, 'PDF_TOO_MANY_PAGES', `The PDF has more than ${opts.maxPages} pages`, { maxPages: opts.maxPages });
  }
  return { pageCount: result.pages };
}

/** Inspect a PDF from a stream, a Buffer or a file path. Reads at most maxBytes into memory (bounded). */
export async function inspectPdf(input: NodeJS.ReadableStream | Buffer | string, opts: InspectPdfOptions = {}): Promise<{ pageCount: number }> {
  const limit = Math.min(opts.maxBytes ?? PDF_BUFFER_HARD_CAP, PDF_BUFFER_HARD_CAP);
  let buf: Buffer;
  if (Buffer.isBuffer(input)) buf = input;
  else if (typeof input === 'string') {
    const st = await fs.stat(input);
    if (st.size > limit) throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size');
    buf = await fs.readFile(input);
  } else buf = await collect(input, limit);
  return inspectPdfBuffer(buf, opts);
}

export function inspectPng(head: Buffer, tail: Buffer): { width: number; height: number } {
  const bad = (m = 'The PNG image is invalid') => new AppError(422, 'INVALID_FILE_TYPE', m);
  if (head.length < 33 || head.readUInt32BE(8) !== 13 || head.subarray(12, 16).toString('latin1') !== 'IHDR') throw bad();
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  checkDimensions(width, height);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  if (tail.length < 12 || !tail.subarray(tail.length - 12).equals(iend)) throw bad('The PNG image appears to be truncated');
  return { width, height };
}

export function inspectJpeg(head: Buffer, tail: Buffer): { width: number; height: number } {
  const bad = (m = 'The JPEG image is invalid') => new AppError(422, 'INVALID_FILE_TYPE', m);
  let i = 2;
  let dims: { width: number; height: number } | undefined;
  while (i + 4 <= head.length) {
    if (head[i] !== 0xff) throw bad();
    let marker = head[i + 1]!;
    while (marker === 0xff && i + 2 < head.length) {
      i++;
      marker = head[i + 1]!;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS before SOF => no frame header
    const len = head.readUInt16BE(i + 2);
    if (len < 2) throw bad();
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > head.length || len < 8) throw bad();
      dims = { height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7) };
      break;
    }
    i += 2 + len;
  }
  if (!dims) throw bad();
  checkDimensions(dims.width, dims.height);
  const t = tail.subarray(Math.max(0, tail.length - 64));
  let eoi = false;
  for (let k = t.length - 2; k >= 0; k--) if (t[k] === 0xff && t[k + 1] === 0xd9) eoi = true;
  if (!eoi) throw bad('The JPEG image appears to be truncated');
  return dims;
}

function checkDimensions(width: number, height: number): void {
  if (width < 1 || height < 1) throw new AppError(422, 'INVALID_FILE_TYPE', 'The image has invalid dimensions');
  if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION || width * height > IMAGE_MAX_PIXELS) {
    throw new AppError(422, 'INVALID_FILE_TYPE', 'The image dimensions are too large');
  }
}

/**
 * Detect the real type of a stored object (magic bytes only) and validate it.
 * `size` must come from storage.head / put, not from the client.
 */
export async function inspectStoredObject(
  storage: Storage,
  key: string,
  size: number,
  opts: { maxPdfPages: number; timeoutMs?: number }
): Promise<InspectResult> {
  if (size <= 0) throw new AppError(422, 'EMPTY_FILE', 'The file is empty');
  const head = await collect(await storage.openRead(key, { start: 0, end: Math.min(size, HEAD_BYTES) - 1 }), HEAD_BYTES + 1);
  const mime = signatureMime(head);
  if (!mime) throw new AppError(422, 'INVALID_FILE_TYPE', 'Only PDF, JPEG and PNG files are supported');
  if (mime === 'application/pdf') {
    const buf = await collect(await storage.openRead(key), Math.min(size, PDF_BUFFER_HARD_CAP));
    const { pageCount } = await inspectPdfBuffer(buf, { maxPages: opts.maxPdfPages, timeoutMs: opts.timeoutMs });
    return { mime, pageCount };
  }
  const tailStart = Math.max(0, size - 64);
  const tail = await collect(await storage.openRead(key, { start: tailStart, end: size - 1 }), 65);
  if (mime === 'image/png') inspectPng(head, tail);
  else inspectJpeg(head, tail);
  return { mime: mime as 'image/png' | 'image/jpeg', pageCount: 1 };
}
