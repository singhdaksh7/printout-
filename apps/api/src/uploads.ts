import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DocumentStatus, type Document, type PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { publicIntakeWhere } from './domain/eligibility.js';
import { AppError } from './errors.js';
import { inspectStoredObject } from './pdf/index.js';
import { deriveSecret, generateObjectKey, hmacHex, safeEqualHex, StorageError, type Storage } from './storage/index.js';
import { sanitizeFilename } from './storage/filename.js';

export const ACCEPTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
/** Upload token lifetime and the reclaim deadline for documents that never complete. */
export const UPLOAD_TOKEN_TTL_SECONDS = 15 * 60;
export const UPLOADING_RECLAIM_MS = 60 * 60 * 1000;

export interface UploadsConfig {
  SESSION_SECRET: string;
  STORAGE_URL_SECRET?: string;
  UPLOAD_MAX_BYTES: number;
  UPLOAD_MAX_PDF_PAGES: number;
  UNPRINTED_RETENTION_HOURS: number;
  PUBLIC_API_BASE?: string;
  PUBLIC_RATE_LIMIT_MAX?: number;
  /** Per-IP uploads initiated per minute (default PUBLIC_RATE_LIMIT_MAX / 3 = 20 at the default of 60). */
  UPLOAD_INITIATE_RATE_LIMIT_MAX?: number;
  /** Test hook: PDF parse wall-clock budget. */
  PDF_INSPECT_TIMEOUT_MS?: number;
}
export interface UploadRoutesOptions {
  prisma: PrismaClient;
  storage: Storage;
  config: UploadsConfig;
  prefix?: string;
}

const slugParam = z.string().regex(/^[a-z0-9-]{3,80}$/);
const idParam = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const initiateBody = z
  .object({
    fileName: z.string().min(1).max(255),
    byteSize: z.number().int().min(0),
    declaredMimeType: z.enum(ACCEPTED_MIME_TYPES)
  })
  .strict();

export function uploadToken(secret: Buffer, uploadId: string, key: string, exp: number): string {
  return `${exp}.${hmacHex(secret, `upload:${uploadId}:${key}:${exp}`)}`;
}
export function verifyUploadToken(secret: Buffer, uploadId: string, key: string, token: unknown, nowMs = Date.now()): 'ok' | 'expired' | 'invalid' {
  if (typeof token !== 'string') return 'invalid';
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return 'invalid';
  const exp = Number(m[1]);
  if (!safeEqualHex(m[2]!, hmacHex(secret, `upload:${uploadId}:${key}:${exp}`))) return 'invalid';
  return exp * 1000 <= nowMs ? 'expired' : 'ok';
}

const completionPayload = (d: Document) => ({
  documentId: d.id,
  detectedMimeType: d.detectedMimeType,
  byteSize: Number(d.byteSize ?? 0),
  pageCount: d.pageCount,
  documentStatus: d.status,
  uploadedAt: d.uploadedAt,
  expiresAt: d.expiresAt
});

export const uploadRoutes: FastifyPluginAsync<UploadRoutesOptions> = async (app, opts) => {
  const { prisma, storage, config } = opts;
  const prefix = (opts.prefix ?? '/api/v1').replace(/\/$/, '');
  const secret = deriveSecret(config, 'upload-token');
  const inFlight = new Set<string>();
  const publicMax = config.PUBLIC_RATE_LIMIT_MAX ?? 60;

  // Raw, unparsed body for the streamed PUT. Scoped to this plugin so JSON parsing elsewhere is untouched.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  const failDocument = async (doc: Document, deleteObject = true) => {
    const res = await prisma.document.updateMany({ where: { id: doc.id, status: DocumentStatus.UPLOADING }, data: { status: DocumentStatus.FAILED } });
    if (deleteObject && res.count === 1) await storage.delete(doc.objectKey).catch(() => undefined);
  };

  app.post<{ Params: { slug: string } }>(
    '/public/shops/:slug/uploads/initiate',
    { config: { rateLimit: { max: config.UPLOAD_INITIATE_RATE_LIMIT_MAX ?? Math.max(1, Math.ceil(publicMax / 3)), timeWindow: '1 minute' } } },
    async (request) => {
      const slug = slugParam.parse(request.params.slug);
      const body = initiateBody.parse(request.body);
      const shop = await prisma.shop.findFirst({ where: { slug, acceptsOrders: true, AND: [publicIntakeWhere] }, select: { id: true } });
      if (!shop) throw new AppError(404, 'SHOP_UNAVAILABLE', 'This shop is not accepting orders');
      if (body.byteSize === 0) throw new AppError(422, 'EMPTY_FILE', 'The file is empty');
      if (body.byteSize > config.UPLOAD_MAX_BYTES) {
        throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size', { maxBytes: config.UPLOAD_MAX_BYTES });
      }
      const key = generateObjectKey();
      const now = Date.now();
      // While UPLOADING, byteSize / detectedMimeType hold the client's DECLARED values; both are overwritten with
      // server-verified values at completion. expiresAt lets the retention worker sweep abandoned uploads.
      const doc = await prisma.document.create({
        data: {
          // Unguessable id (the id is the capability for quote/order/complete); cuid() is partly predictable.
          id: randomBytes(18).toString('base64url'),
          shopId: shop.id,
          objectKey: key,
          originalFilename: sanitizeFilename(body.fileName),
          detectedMimeType: body.declaredMimeType,
          byteSize: BigInt(body.byteSize),
          status: DocumentStatus.UPLOADING,
          expiresAt: new Date(now + UPLOADING_RECLAIM_MS)
        }
      });
      const exp = Math.floor(now / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
      const base = (config.PUBLIC_API_BASE ?? '').replace(/\/$/, '');
      return {
        data: {
          uploadId: doc.id,
          uploadUrl: `${base}${prefix}/public/uploads/${doc.id}/content?token=${uploadToken(secret, doc.id, key, exp)}`,
          requiredHeaders: { 'content-type': body.declaredMimeType },
          expiresAt: new Date(exp * 1000),
          limits: {
            acceptedMimeTypes: [...ACCEPTED_MIME_TYPES],
            maxBytes: config.UPLOAD_MAX_BYTES,
            maxPdfPages: config.UPLOAD_MAX_PDF_PAGES,
            imagePageCount: 1
          }
        }
      };
    }
  );

  app.put<{ Params: { uploadId: string }; Querystring: { token?: string } }>(
    '/public/uploads/:uploadId/content',
    {
      bodyLimit: config.UPLOAD_MAX_BYTES + 1,
      config: { rateLimit: { max: Math.max(1, Math.ceil(publicMax / 2)), timeWindow: '1 minute' } },
      // Fastify's built-in JSON/text parsers would buffer and parse up to UPLOAD_MAX_BYTES in memory. Refuse them before parsing.
      onRequest: async (request) => {
        const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (type && type !== 'application/octet-stream' && !(ACCEPTED_MIME_TYPES as readonly string[]).includes(type)) {
          throw new AppError(415, 'INVALID_FILE_TYPE', 'Upload the raw file with its own content type');
        }
      }
    },
    async (request, reply) => {
      const uploadId = idParam.safeParse(request.params.uploadId);
      if (!uploadId.success) throw new AppError(404, 'NOT_FOUND', 'Upload not found');
      const doc = await prisma.document.findUnique({ where: { id: uploadId.data } });
      if (!doc || doc.status !== DocumentStatus.UPLOADING) throw new AppError(404, 'NOT_FOUND', 'Upload not found');
      const verdict = verifyUploadToken(secret, doc.id, doc.objectKey, request.query.token);
      if (verdict !== 'ok') throw new AppError(403, 'FORBIDDEN', verdict === 'expired' ? 'Upload link has expired' : 'Invalid upload token');

      const declared = Number(doc.byteSize ?? 0);
      const cap = Math.min(declared, config.UPLOAD_MAX_BYTES);
      const lenHeader = request.headers['content-length'];
      const length = lenHeader === undefined ? undefined : Number(lenHeader);
      if (length !== undefined && (!Number.isFinite(length) || length < 0)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid Content-Length');
      if (length === 0) throw new AppError(422, 'EMPTY_FILE', 'The file is empty');
      if (length !== undefined && length > cap) {
        await failDocument(doc, false);
        // The (lying) client may keep streaming: answer, then close the socket instead of waiting for the body.
        reply.header('connection', 'close');
        throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds the declared or maximum size', { maxBytes: cap });
      }
      const body = request.body as Readable | undefined;
      if (!body || typeof (body as Readable).pipe !== 'function') throw new AppError(422, 'EMPTY_FILE', 'The file is empty');

      // Single use: the object must not exist yet and no other PUT may be in flight for this upload.
      if (inFlight.has(doc.id) || (await storage.exists(doc.objectKey))) throw new AppError(409, 'CONFLICT', 'This upload link has already been used');
      inFlight.add(doc.id);
      let result: { size: number; sha256: string };
      try {
        result = await storage.put(doc.objectKey, body, { maxBytes: cap, contentType: doc.detectedMimeType ?? undefined });
      } catch (e) {
        await storage.delete(doc.objectKey).catch(() => undefined);
        if (e instanceof AppError && e.code === 'FILE_TOO_LARGE') {
          await failDocument(doc, false);
          // The client may still be sending; stop reading and close after replying.
          reply.header('connection', 'close');
          throw e;
        }
        if (e instanceof StorageError && e.code === 'KEY_EXISTS') throw new AppError(409, 'CONFLICT', 'This upload link has already been used');
        throw e;
      } finally {
        inFlight.delete(doc.id);
      }
      if (result.size === 0) {
        await storage.delete(doc.objectKey).catch(() => undefined);
        await failDocument(doc, false);
        throw new AppError(422, 'EMPTY_FILE', 'The file is empty');
      }
      // checksum is recorded here (computed in-stream); byteSize is the real stored size.
      await prisma.document.updateMany({
        where: { id: doc.id, status: DocumentStatus.UPLOADING },
        data: { checksum: result.sha256, byteSize: BigInt(result.size) }
      });
      return { data: { uploadId: doc.id, byteSize: result.size } };
    }
  );

  app.post<{ Params: { slug: string; uploadId: string } }>(
    '/public/shops/:slug/uploads/:uploadId/complete',
    { config: { rateLimit: { max: publicMax, timeWindow: '1 minute' } } },
    async (request) => {
      const slug = slugParam.parse(request.params.slug);
      const uploadId = idParam.safeParse(request.params.uploadId);
      if (!uploadId.success) throw new AppError(404, 'NOT_FOUND', 'Upload not found');
      const doc = await prisma.document.findFirst({ where: { id: uploadId.data, shop: { slug, ...publicIntakeWhere } } });
      if (!doc) throw new AppError(404, 'NOT_FOUND', 'Upload not found');
      if (doc.status === DocumentStatus.AVAILABLE) return { data: completionPayload(doc) };
      if (doc.status !== DocumentStatus.UPLOADING) throw new AppError(409, 'DOCUMENT_UNAVAILABLE', 'This upload is no longer available; start a new upload');

      const head = await storage.head(doc.objectKey);
      if (!head) throw new AppError(409, 'CONFLICT', 'The file content has not been received yet');
      const declaredMime = doc.detectedMimeType;
      let inspected;
      try {
        if (head.size === 0) throw new AppError(422, 'EMPTY_FILE', 'The file is empty');
        if (head.size > config.UPLOAD_MAX_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size');
        inspected = await inspectStoredObject(storage, doc.objectKey, head.size, { maxPdfPages: config.UPLOAD_MAX_PDF_PAGES, timeoutMs: config.PDF_INSPECT_TIMEOUT_MS });
        if (declaredMime && declaredMime !== inspected.mime) {
          throw new AppError(422, 'INVALID_FILE_TYPE', 'The file content does not match its declared type');
        }
      } catch (e) {
        if (e instanceof AppError) {
          await failDocument(doc);
          throw e;
        }
        request.log.error({ err: e, uploadId: doc.id }, 'upload inspection failed unexpectedly');
        throw e;
      }

      let checksum = doc.checksum;
      if (!checksum) {
        const hash = createHash('sha256');
        for await (const chunk of await storage.openRead(doc.objectKey)) hash.update(chunk as Buffer);
        checksum = hash.digest('hex');
      }
      const now = new Date();
      const res = await prisma.document.updateMany({
        where: { id: doc.id, status: DocumentStatus.UPLOADING },
        data: {
          status: DocumentStatus.AVAILABLE,
          detectedMimeType: inspected.mime,
          byteSize: BigInt(head.size),
          pageCount: inspected.pageCount,
          checksum,
          uploadedAt: now,
          expiresAt: new Date(now.getTime() + config.UNPRINTED_RETENTION_HOURS * 3600e3)
        }
      });
      const saved = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      if (res.count === 0 && saved.status !== DocumentStatus.AVAILABLE) {
        throw new AppError(409, 'DOCUMENT_UNAVAILABLE', 'This upload is no longer available; start a new upload');
      }
      return { data: completionPayload(saved) };
    }
  );
};
