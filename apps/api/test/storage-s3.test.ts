import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { createS3Client, createStorage, generateObjectKey, S3Storage } from '../src/storage/index.js';

const s3 = mockClient(S3Client);
const client = createS3Client({ endpoint: 'http://localhost:9000', region: 'auto', accessKeyId: 'AKIATEST', secretAccessKey: 'secretsecretsecret', forcePathStyle: true });
const storage = new S3Storage({ bucket: 'printout-private', client });

beforeEach(() => s3.reset());

describe('S3 driver (stubbed client, no network)', () => {
  it('streams a put with byte counting and sha256', async () => {
    s3.on(PutObjectCommand).resolves({});
    const key = generateObjectKey();
    const data = Buffer.from('hello world, hello pdf');
    const res = await storage.put(key, Readable.from([data.subarray(0, 7), data.subarray(7)]), { maxBytes: 1000, contentType: 'application/pdf' });
    expect(res).toEqual({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    const input = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Bucket: 'printout-private', Key: key, ContentType: 'application/pdf' });
    expect(Buffer.from(input.Body as Buffer).equals(data)).toBe(true);
  });

  it('rejects an oversize body mid-stream and cleans up', async () => {
    s3.on(PutObjectCommand).resolves({});
    s3.on(DeleteObjectCommand).resolves({});
    const key = generateObjectKey();
    const chunks = Array.from({ length: 20 }, () => Buffer.alloc(1000, 2));
    await expect(storage.put(key, Readable.from(chunks), { maxBytes: 5000 })).rejects.toBeInstanceOf(AppError);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(s3.commandCalls(DeleteObjectCommand).length).toBeGreaterThanOrEqual(1);
  });

  it('head maps 404 to null and reports size otherwise', async () => {
    const key = generateObjectKey();
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    expect(await storage.head(key)).toBeNull();
    expect(await storage.exists(key)).toBe(false);
    s3.reset();
    s3.on(HeadObjectCommand).resolves({ ContentLength: 42 });
    expect(await storage.head(key)).toEqual({ size: 42 });
    expect(await storage.exists(key)).toBe(true);
    s3.reset();
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    await expect(storage.head(key)).rejects.toThrow('denied');
  });

  it('openRead sends an HTTP Range header', async () => {
    const key = generateObjectKey();
    s3.on(GetObjectCommand).resolves({ Body: Readable.from([Buffer.from('abc')]) as never });
    const stream = await storage.openRead(key, { start: 10, end: 19 });
    const parts: Buffer[] = [];
    for await (const c of stream) parts.push(c as Buffer);
    expect(Buffer.concat(parts).toString()).toBe('abc');
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input.Range).toBe('bytes=10-19');
  });

  it('delete is idempotent', async () => {
    const key = generateObjectKey();
    s3.on(DeleteObjectCommand).rejects(Object.assign(new Error('nk'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }));
    await expect(storage.delete(key)).resolves.toBeUndefined();
    s3.reset();
    s3.on(DeleteObjectCommand).resolves({});
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('rejects invalid keys before touching the network', async () => {
    await expect(storage.head('../x')).rejects.toThrow('Invalid object key');
    await expect(storage.delete('a/b')).rejects.toThrow('Invalid object key');
    expect(s3.calls()).toHaveLength(0);
  });

  it('presigns a short-lived inline GET and honours the TTL upper bound', async () => {
    const key = generateObjectKey();
    const { url, expiresAt } = await storage.temporaryReadUrl(key, 60, { contentType: 'application/pdf', filename: 'my "doc".pdf' });
    const u = new URL(url);
    expect(u.origin).toBe('http://localhost:9000');
    expect(u.pathname).toBe(`/printout-private/${key}`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(u.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(u.searchParams.get('response-content-disposition')).toMatch(/^inline; filename="my _doc_\.pdf"$/);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    const long = new URL((await storage.temporaryReadUrl(key, 99_999_999)).url);
    expect(Number(long.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(604_800);
  });

  it('createStorage selects the s3 driver and requires a bucket', () => {
    const base = { SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 's3' as const };
    expect(() => createStorage(base)).toThrow('S3_BUCKET');
    expect(createStorage({ ...base, S3_BUCKET: 'b', S3_ENDPOINT: 'http://localhost:9000', S3_REGION: 'auto', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b', S3_FORCE_PATH_STYLE: 'true' })).toBeInstanceOf(S3Storage);
  });
});
