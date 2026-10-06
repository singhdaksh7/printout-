import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildUploadsApp, uploadFile } from './fixtures/app.js';
import { makeJpeg, makePdf } from './fixtures/make.js';
import { resetDb, testPrisma } from './helpers/db.js';

const prisma = testPrisma();
let ctx: Awaited<ReturnType<typeof buildUploadsApp>>;
let pdf: Buffer;

beforeAll(async () => {
  ctx = await buildUploadsApp(prisma);
  pdf = await makePdf(2);
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetDb(prisma);
  await prisma.shop.create({ data: { slug: 'copy-corner', displayName: 'Copy Corner' } });
});

async function availableDoc(file = pdf, mime = 'application/pdf', fileName = 'My File.pdf') {
  const { uploadId } = await uploadFile(ctx.app, 'copy-corner', file, mime, fileName);
  await ctx.app.inject({ method: 'POST', url: `/api/v1/public/shops/copy-corner/uploads/${uploadId}/complete` });
  return prisma.document.findUniqueOrThrow({ where: { id: uploadId } });
}
const signed = async (key: string, secs = 300) => (await ctx.storage.temporaryReadUrl(key, secs)).url;
const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'GET', url, headers });

describe('signed document delivery (local driver)', () => {
  it('serves the document with hardened headers and does not touch timestamps', async () => {
    const doc = await availableDoc();
    const res = await get(await signed(doc.objectKey));
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(pdf)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="My File\.pdf"/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['accept-ranges']).toBe('bytes');
    const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.updatedAt).toEqual(doc.updatedAt);
    expect(after.deleteAfter).toBeNull();
    expect(after.expiresAt).toEqual(doc.expiresAt);
  });

  it('serves images with a sandbox CSP', async () => {
    const doc = await availableDoc(makeJpeg(), 'image/jpeg', 'p.jpg');
    const res = await get(await signed(doc.objectKey));
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
  });

  it('supports Range requests', async () => {
    const doc = await availableDoc();
    const url = await signed(doc.objectKey);
    const r = await get(url, { range: 'bytes=0-9' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 0-9/${pdf.length}`);
    expect(r.rawPayload.equals(pdf.subarray(0, 10))).toBe(true);
    const tail = await get(url, { range: 'bytes=-5' });
    expect(tail.rawPayload.equals(pdf.subarray(pdf.length - 5))).toBe(true);
    const open = await get(url, { range: `bytes=${pdf.length - 3}-` });
    expect(open.rawPayload.equals(pdf.subarray(pdf.length - 3))).toBe(true);
    expect((await get(url, { range: `bytes=${pdf.length + 5}-` })).statusCode).toBe(416);
    expect((await get(url, { range: 'bytes=abc' })).statusCode).toBe(416);
  });

  it('rejects bad signature, tampered expiry, wrong key and expired links', async () => {
    const doc = await availableDoc();
    const url = await signed(doc.objectKey);
    expect((await get(url.replace(/sig=([0-9a-f])/, (_m: string, c: string) => 'sig=' + (c === '0' ? '1' : '0')))).statusCode).toBe(403);
    expect((await get(url.replace(/sig=[0-9a-f]+/, ''))).statusCode).toBe(403);
    expect((await get(url.replace(/exp=(\d+)/, (_m, e) => `exp=${Number(e) + 1000}`))).statusCode).toBe(403);
    const other = await signed('B'.repeat(43));
    expect((await get(url.replace(doc.objectKey, 'B'.repeat(43)))).statusCode).toBe(403);
    expect((await get(other)).statusCode).toBe(404); // valid signature, no such document
    const expired = new URL(await signed(doc.objectKey, 1), 'http://x');
    await new Promise((r) => setTimeout(r, 2100));
    expect((await get(expired.pathname + expired.search)).statusCode).toBe(403);
  });

  it('denies after deleteAfter even though the object still exists (410)', async () => {
    const doc = await availableDoc();
    await prisma.document.update({ where: { id: doc.id }, data: { status: 'PRINTED_RETENTION', printedAt: new Date(), deleteAfter: new Date(Date.now() + 60_000) } });
    const url = await signed(doc.objectKey);
    expect((await get(url)).statusCode).toBe(200);
    await prisma.document.update({ where: { id: doc.id }, data: { deleteAfter: new Date(Date.now() - 1000) } });
    expect(await ctx.storage.exists(doc.objectKey)).toBe(true);
    expect((await get(url)).statusCode).toBe(410);
  });

  it('denies unprinted documents past expiresAt, DELETED, FAILED and UPLOADING documents', async () => {
    const doc = await availableDoc();
    const url = await signed(doc.objectKey);
    await prisma.document.update({ where: { id: doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get(url)).statusCode).toBe(410);
    await prisma.document.update({ where: { id: doc.id }, data: { expiresAt: new Date(Date.now() + 60_000), status: 'DELETED', deletedAt: new Date() } });
    expect((await get(url)).statusCode).toBe(410);
    await prisma.document.update({ where: { id: doc.id }, data: { status: 'FAILED' } });
    expect((await get(url)).statusCode).toBe(404);
    await prisma.document.update({ where: { id: doc.id }, data: { status: 'UPLOADING' } });
    expect((await get(url)).statusCode).toBe(404);
  });

  it('returns 404 (no storage internals) when the object is gone', async () => {
    const doc = await availableDoc();
    const url = await signed(doc.objectKey);
    await ctx.storage.delete(doc.objectKey);
    const res = await get(url);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(ctx.dir);
  });

  it('rejects traversal-shaped keys without hitting storage', async () => {
    for (const k of ['..%2f..%2fetc%2fpasswd', '%2e%2e', 'short']) {
      const res = await get(`/api/v1/internal/documents/${k}?exp=${Math.floor(Date.now() / 1000) + 60}&sig=${'0'.repeat(64)}`);
      expect([404, 403]).toContain(res.statusCode);
    }
  });
});
