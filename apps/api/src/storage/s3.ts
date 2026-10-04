import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertKey } from './keys.js';
import { pumpLimited } from './pump.js';
import { MAX_PRESIGN_SECONDS, type Storage } from './types.js';

export interface S3StorageOptions {
  bucket: string;
  client: S3Client;
}

/** Per-attempt network bounds. requestTimeout is a socket IDLE timeout (large streamed uploads keep it alive). */
export const S3_CONNECTION_TIMEOUT_MS = 5_000;
export const S3_REQUEST_TIMEOUT_MS = 60_000;
export const S3_MAX_ATTEMPTS = 3;

/**
 * Credentials, endpoint, region and path style come ONLY from the (env-derived) config handed in here. The bucket must be
 * PRIVATE (no public ACL/policy): documents are only ever reachable through short-lived presigned GETs the API issues.
 */
export function createS3Client(c: { endpoint?: string; region?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle?: boolean }) {
  return new S3Client({
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: S3_CONNECTION_TIMEOUT_MS, requestTimeout: S3_REQUEST_TIMEOUT_MS },
    region: c.region || 'auto',
    endpoint: c.endpoint || undefined,
    forcePathStyle: c.forcePathStyle ?? false,
    credentials: c.accessKeyId && c.secretAccessKey ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } : undefined,
    // R2 / MinIO do not accept the newer default checksum trailers on streamed bodies.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  });
}

/**
 * Only "the object does not exist" counts as not-found. A 404 NoSuchBucket (misconfiguration) or any 403/5xx/timeout must
 * surface as an error, otherwise delete() would report success and retention would mark documents DELETED that still exist.
 */
const notFound = (e: any) => e?.name === 'NotFound' || e?.name === 'NoSuchKey' || (e?.$metadata?.httpStatusCode === 404 && e?.name !== 'NoSuchBucket');
const safeFilename = (n: string) => n.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document';

export class S3Storage implements Storage {
  private readonly bucket: string;
  private readonly client: S3Client;
  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    this.client = opts.client;
  }

  async put(key: string, body: NodeJS.ReadableStream, opts: { maxBytes: number; contentType?: string }) {
    assertKey(key);
    const hash = createHash('sha256');
    const pass = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: pass, ContentType: opts.contentType ?? 'application/octet-stream', CacheControl: 'private, no-store' },
      queueSize: 2,
      leavePartsOnError: false
    });
    let size = 0;
    try {
      [size] = await Promise.all([pumpLimited(body, pass, opts.maxBytes, (c) => hash.update(c)), upload.done()]);
    } catch (e) {
      pass.destroy();
      await upload.abort().catch(() => undefined);
      await this.delete(key).catch(() => undefined);
      throw e;
    }
    return { size, sha256: hash.digest('hex') };
  }

  async head(key: string) {
    assertKey(key);
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }

  async exists(key: string) {
    return (await this.head(key)) !== null;
  }

  async openRead(key: string, range?: { start: number; end: number }) {
    assertKey(key);
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
    if (!r.Body) throw new Error('Empty body');
    return r.Body as NodeJS.ReadableStream;
  }

  async delete(key: string) {
    assertKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      if (!notFound(e)) throw e;
    }
  }

  async temporaryReadUrl(key: string, expiresSeconds: number, opts?: { contentType?: string; filename?: string }) {
    assertKey(key);
    // Hard cap: never longer than the caller asked for, and never beyond MAX_PRESIGN_SECONDS (callers also cap at deleteAfter).
    const seconds = Math.min(MAX_PRESIGN_SECONDS, Math.max(1, Math.floor(expiresSeconds)));
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: `inline; filename="${safeFilename(opts?.filename ?? 'document')}"`,
      ResponseContentType: opts?.contentType,
      ResponseCacheControl: 'private, no-store'
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: seconds });
    return { url, expiresAt: new Date(Date.now() + seconds * 1000) };
  }
}
