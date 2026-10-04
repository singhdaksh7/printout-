import { DocumentStatus, type PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from './errors.js';
import { isValidObjectKey, LocalStorage, type Storage } from './storage/index.js';
import { contentDispositionInline } from './storage/filename.js';

export interface InternalStorageOptions {
  prisma: PrismaClient;
  storage: Storage;
  config?: unknown;
  prefix?: string;
}

/** Parses a single `bytes=` range. Returns null if absent, 'invalid' if unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

const CSP_PDF = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'";
const CSP_IMAGE = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; sandbox";

/**
 * Local-driver document delivery. The signature proves the URL was issued by the API; the DB row is re-checked on
 * every request, so a leaked URL stops working at deleteAfter/expiresAt even if the object still exists. Never mutates the Document.
 */
export const internalStorageRoutes: FastifyPluginAsync<InternalStorageOptions> = async (app, opts) => {
  const { prisma, storage } = opts;

  app.get<{ Params: { key: string }; Querystring: { exp?: string; sig?: string } }>('/internal/documents/:key', async (request, reply) => {
    const { key } = request.params;
    const gone = () => new AppError(404, 'NOT_FOUND', 'Document not found');
    if (!(storage instanceof LocalStorage) || !isValidObjectKey(key)) throw gone();
    const exp = Number(request.query.exp);
    const sig = request.query.sig ?? '';
    if (!/^\d{1,12}$/.test(request.query.exp ?? '') || !storage.verifyRead(key, exp, sig)) {
      throw new AppError(403, 'FORBIDDEN', 'Invalid or expired link');
    }

    const now = new Date();
    const doc = await prisma.document.findUnique({ where: { objectKey: key } });
    if (!doc) throw gone();
    if (doc.status === DocumentStatus.DELETED) throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'Document is no longer available');
    if (doc.status !== DocumentStatus.AVAILABLE && doc.status !== DocumentStatus.PRINTED_RETENTION) throw gone();
    if (doc.deleteAfter && doc.deleteAfter <= now) throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'Document is no longer available');
    if (doc.status === DocumentStatus.AVAILABLE && doc.expiresAt && doc.expiresAt <= now) {
      throw new AppError(410, 'DOCUMENT_UNAVAILABLE', 'Document is no longer available');
    }
    if (!doc.detectedMimeType) throw gone();

    const head = await storage.head(key);
    if (!head) throw gone();
    const range = parseRange(request.headers.range, head.size);
    if (range === 'invalid') {
      return reply.code(416).header('content-range', `bytes */${head.size}`).send();
    }

    reply
      .header('content-type', doc.detectedMimeType)
      .header('content-disposition', contentDispositionInline(doc.originalFilename))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', doc.detectedMimeType === 'application/pdf' ? CSP_PDF : CSP_IMAGE)
      .header('accept-ranges', 'bytes');
    if (range) {
      reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${head.size}`).header('content-length', range.end - range.start + 1);
      return reply.send(await storage.openRead(key, range));
    }
    reply.header('content-length', head.size);
    return reply.send(await storage.openRead(key));
  });
};
