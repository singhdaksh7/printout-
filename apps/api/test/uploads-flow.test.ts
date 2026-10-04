import { readdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testPrisma } from './helpers/db.js';
import { buildUploadsApp, uploadFile } from './fixtures/app.js';
import { makeEncryptedPdf, makeExe, makeJpeg, makePdf, makePng, makeTruncatedPdf } from './fixtures/make.js';

const prisma = testPrisma();
let ctx: Awaited<ReturnType<typeof buildUploadsApp>>;
const stored = () => readdirSync(ctx.dir).filter((f) => f !== '.tmp');

beforeAll(async () => {
  ctx = await buildUploadsApp(prisma);
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(prisma);
  for (const f of stored()) rmSync(`${ctx.dir}/${f}`, { force: true });
  await prisma.shop.create({ data: { slug: 'copy-corner', displayName: 'Copy Corner' } });
  await prisma.shop.create({ data: { slug: 'other-shop', displayName: 'Other' } });
});

const complete = (slug: string, id: string) => ctx.app.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/uploads/${id}/complete` });
const initiate = (payload: unknown, slug = 'copy-corner') => ctx.app.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/uploads/initiate`, payload: payload as object });

describe('initiate', () => {
  it('creates an UPLOADING document with a reclaimable expiry and returns the contract shape', async () => {
    const before = Date.now();
    const res = await initiate({ fileName: 'a.pdf', byteSize: 1234, declaredMimeType: 'application/pdf' });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.uploadUrl).toMatch(new RegExp(`^/api/v1/public/uploads/${d.uploadId}/content\\?token=\\d+\\.[0-9a-f]{64}$`));
    expect(d.requiredHeaders).toEqual({ 'content-type': 'application/pdf' });
    expect(d.limits).toEqual({ acceptedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 1_000_000, maxPdfPages: 5, imagePageCount: 1 });
    expect(JSON.stringify(d)).not.toContain(ctx.dir);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: d.uploadId } });
    expect(doc.status).toBe('UPLOADING');
    expect(doc.objectKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(doc.expiresAt!.getTime()).toBeGreaterThan(before + 59 * 60_000);
    expect(doc.expiresAt!.getTime()).toBeLessThan(Date.now() + 61 * 60_000);
  });

  it('sanitises the stored original filename', async () => {
    const res = await initiate({ fileName: '../../etc/pass\u0000wd‮.pdf', byteSize: 10, declaredMimeType: 'application/pdf' });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: res.json().data.uploadId } });
    expect(doc.originalFilename).toBe('passwd.pdf');
    expect(doc.objectKey).not.toContain('passwd');
  });

  it('validates strictly', async () => {
    expect((await initiate({ fileName: 'a.pdf', byteSize: 10, declaredMimeType: 'text/html' })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await initiate({ fileName: '', byteSize: 10, declaredMimeType: 'application/pdf' })).statusCode).toBe(400);
    expect((await initiate({ fileName: 'a'.repeat(256), byteSize: 10, declaredMimeType: 'application/pdf' })).statusCode).toBe(400);
    expect((await initiate({ fileName: 'a.pdf', byteSize: 10, declaredMimeType: 'application/pdf', extra: 1 })).statusCode).toBe(400);
    const big = await initiate({ fileName: 'a.pdf', byteSize: 1_000_001, declaredMimeType: 'application/pdf' });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('FILE_TOO_LARGE');
    const empty = await initiate({ fileName: 'a.pdf', byteSize: 0, declaredMimeType: 'application/pdf' });
    expect(empty.json().error.code).toBe('EMPTY_FILE');
    expect(await prisma.document.count()).toBe(0);
  });

  it('refuses unknown, suspended and non-accepting shops', async () => {
    const body = { fileName: 'a.pdf', byteSize: 10, declaredMimeType: 'application/pdf' };
    expect((await initiate(body, 'nope-nope')).statusCode).toBe(404);
    await prisma.shop.update({ where: { slug: 'copy-corner' }, data: { acceptsOrders: false } });
    expect((await initiate(body)).json().error.code).toBe('SHOP_UNAVAILABLE');
    await prisma.shop.update({ where: { slug: 'copy-corner' }, data: { acceptsOrders: true, status: 'SUSPENDED' } });
    expect((await initiate(body)).json().error.code).toBe('SHOP_UNAVAILABLE');
  });
});

describe('happy path', () => {
  it.each([
    ['PDF', async () => makePdf(3), 'application/pdf', 3],
    ['PNG', async () => makePng(), 'image/png', 1],
    ['JPEG', async () => makeJpeg(), 'image/jpeg', 1]
  ] as const)('%s uploads, completes and is AVAILABLE with 24h expiry', async (_n, make, mime, pages) => {
    const file = await make();
    const { put, uploadId } = await uploadFile(ctx.app, 'copy-corner', file, mime);
    expect(put!.statusCode).toBe(200);
    const before = Date.now();
    const res = await complete('copy-corner', uploadId!);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d).toMatchObject({ documentId: uploadId, detectedMimeType: mime, byteSize: file.length, pageCount: pages, documentStatus: 'AVAILABLE' });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: uploadId } });
    expect(doc.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.uploadedAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(doc.expiresAt!.getTime() - doc.uploadedAt!.getTime()).toBe(24 * 3600e3);
    expect(Number(doc.byteSize)).toBe(file.length);
    expect(stored()).toEqual([doc.objectKey]);
  });

  it('complete is idempotent', async () => {
    const { uploadId } = await uploadFile(ctx.app, 'copy-corner', await makePdf(2), 'application/pdf');
    const a = (await complete('copy-corner', uploadId!)).json();
    const b = await complete('copy-corner', uploadId!);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a);
  });

  it('concurrent completes both succeed with identical results', async () => {
    const { uploadId } = await uploadFile(ctx.app, 'copy-corner', await makePdf(2), 'application/pdf');
    const [a, b] = await Promise.all([complete('copy-corner', uploadId!), complete('copy-corner', uploadId!)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json()).toEqual(b.json());
  });
});

describe('validation failures delete the object and mark the document FAILED', () => {
  const cases: [string, () => Promise<Buffer>, string, string, number][] = [
    ['EXE renamed .pdf', async () => makeExe(), 'application/pdf', 'INVALID_FILE_TYPE', 422],
    ['declared PDF but real PNG', async () => makePng(), 'application/pdf', 'INVALID_FILE_TYPE', 422],
    ['declared PNG but real JPEG', async () => makeJpeg(), 'image/png', 'INVALID_FILE_TYPE', 422],
    ['corrupt (truncated) PDF', makeTruncatedPdf, 'application/pdf', 'INVALID_PDF', 422],
    ['encrypted PDF', async () => makeEncryptedPdf(), 'application/pdf', 'PASSWORD_PROTECTED_PDF', 422],
    ['too many pages', async () => makePdf(6), 'application/pdf', 'PDF_TOO_MANY_PAGES', 422],
    ['absurd PNG dimensions', async () => makePng(40_000, 40_000), 'image/png', 'INVALID_FILE_TYPE', 422]
  ];
  it.each(cases)('%s', async (_n, make, mime, code, status) => {
    const { put, uploadId } = await uploadFile(ctx.app, 'copy-corner', await make(), mime, 'evil.pdf');
    expect(put!.statusCode).toBe(200);
    const res = await complete('copy-corner', uploadId!);
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(JSON.stringify(res.json())).not.toMatch(/\.data|printout-up|objectKey/);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: uploadId } });
    expect(doc.status).toBe('FAILED');
    expect(stored()).toEqual([]);
    const again = await complete('copy-corner', uploadId!);
    expect(again.statusCode).toBe(409);
  });

  it('extension is never trusted: PDF named .png with declared pdf mime is judged by content', async () => {
    const { uploadId } = await uploadFile(ctx.app, 'copy-corner', await makePdf(1), 'application/pdf', 'photo.png');
    expect((await complete('copy-corner', uploadId!)).json().data.detectedMimeType).toBe('application/pdf');
  });

  it('complete before content arrives is a retryable conflict, not a failure', async () => {
    const init = await initiate({ fileName: 'a.pdf', byteSize: 10, declaredMimeType: 'application/pdf' });
    const id = init.json().data.uploadId;
    expect((await complete('copy-corner', id)).statusCode).toBe(409);
    expect((await prisma.document.findUniqueOrThrow({ where: { id } })).status).toBe('UPLOADING');
  });
});

describe('streamed PUT', () => {
  it('rejects a body larger than the declared size (Content-Length) and stores nothing', async () => {
    const init = await initiate({ fileName: 'a.pdf', byteSize: 100, declaredMimeType: 'application/pdf' });
    const { uploadId, uploadUrl } = init.json().data;
    const res = await ctx.app.inject({ method: 'PUT', url: uploadUrl, payload: Buffer.alloc(5000, 1) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    expect(stored()).toEqual([]);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe('FAILED');
  });

  it('aborts mid-stream (chunked, no Content-Length) and removes the partial file', async () => {
    const init = await initiate({ fileName: 'a.pdf', byteSize: 3000, declaredMimeType: 'application/pdf' });
    const { uploadId, uploadUrl } = init.json().data;
    const chunks = Array.from({ length: 20 }, () => Buffer.alloc(1000, 1));
    const res = await ctx.app.inject({ method: 'PUT', url: uploadUrl, payload: Readable.from(chunks), headers: { 'transfer-encoding': 'chunked' } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    expect(stored()).toEqual([]);
    expect(readdirSync(`${ctx.dir}/.tmp`)).toEqual([]);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe('FAILED');
  });

  it('rejects an empty body', async () => {
    const init = await initiate({ fileName: 'a.pdf', byteSize: 10, declaredMimeType: 'application/pdf' });
    const res = await ctx.app.inject({ method: 'PUT', url: init.json().data.uploadUrl, payload: '' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('EMPTY_FILE');
    expect(stored()).toEqual([]);
  });

  it('token is single use', async () => {
    const file = await makePdf(1);
    const { uploadUrl, put } = await uploadFile(ctx.app, 'copy-corner', file, 'application/pdf');
    expect(put!.statusCode).toBe(200);
    const again = await ctx.app.inject({ method: 'PUT', url: uploadUrl!, payload: file });
    expect(again.statusCode).toBe(409);
    expect(stored()).toHaveLength(1);
  });

  it('token is dead once the document is completed', async () => {
    const file = await makePdf(1);
    const { uploadUrl, uploadId } = await uploadFile(ctx.app, 'copy-corner', file, 'application/pdf');
    await complete('copy-corner', uploadId!);
    const again = await ctx.app.inject({ method: 'PUT', url: uploadUrl!, payload: file });
    expect(again.statusCode).toBe(404);
  });

  it('rejects missing, forged, cross-document and expired tokens', async () => {
    const a = (await initiate({ fileName: 'a.pdf', byteSize: 10, declaredMimeType: 'application/pdf' })).json().data;
    const b = (await initiate({ fileName: 'b.pdf', byteSize: 10, declaredMimeType: 'application/pdf' })).json().data;
    const base = `/api/v1/public/uploads/${a.uploadId}/content`;
    const put = (url: string) => ctx.app.inject({ method: 'PUT', url, payload: Buffer.from('%PDF-1.4 x') });
    expect((await put(base)).statusCode).toBe(403);
    expect((await put(`${base}?token=1.${'0'.repeat(64)}`)).statusCode).toBe(403);
    expect((await put(`${base}?token=${new URL(b.uploadUrl, 'http://x').searchParams.get('token')}`)).statusCode).toBe(403);
    const [, sig] = new URL(a.uploadUrl, 'http://x').searchParams.get('token')!.split('.');
    expect((await put(`${base}?token=${Math.floor(Date.now() / 1000) + 99999}.${sig}`)).statusCode).toBe(403); // exp tampered
    // Properly signed but expired: forge with the real derivation
    const { uploadToken } = await import('../src/uploads.js');
    const { deriveSecret } = await import('../src/storage/index.js');
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: a.uploadId } });
    const expired = uploadToken(deriveSecret(ctx.config, 'upload-token'), doc.id, doc.objectKey, Math.floor(Date.now() / 1000) - 5);
    const res = await put(`${base}?token=${expired}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/expired/i);
    expect(stored()).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('complete with another shop slug looks like not found', async () => {
    const { uploadId } = await uploadFile(ctx.app, 'copy-corner', await makePdf(1), 'application/pdf');
    expect((await complete('other-shop', uploadId!)).statusCode).toBe(404);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe('UPLOADING');
    expect((await complete('copy-corner', uploadId!)).statusCode).toBe(200);
  });

  it('unknown upload ids and malformed ids are 404', async () => {
    expect((await complete('copy-corner', 'doesnotexist12345')).statusCode).toBe(404);
    expect((await complete('copy-corner', 'x')).statusCode).toBe(404);
  });
});
