import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectPdf, inspectPdfBuffer, inspectStoredObject } from '../src/pdf/index.js';
import { generateObjectKey, LocalStorage } from '../src/storage/index.js';
import { makeEncryptedPdf, makeExe, makeJpeg, makePdf, makePng, makeTruncatedPdf } from './fixtures/make.js';

const dir = mkdtempSync(path.join(tmpdir(), 'printout-insp-'));
const storage = new LocalStorage(dir, 'k');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function inspect(buf: Buffer, maxPdfPages = 200) {
  const key = generateObjectKey();
  await storage.put(key, Readable.from([buf]), { maxBytes: 10_000_000 });
  const size = (await storage.head(key))!.size;
  return inspectStoredObject(storage, key, size, { maxPdfPages });
}

describe('PDF inspection', () => {
  it('counts pages for classic-xref and object-stream PDFs', async () => {
    expect(await inspectPdfBuffer(await makePdf(1, false))).toEqual({ pageCount: 1 });
    expect(await inspectPdfBuffer(await makePdf(7, false))).toEqual({ pageCount: 7 });
    const withObjStm = await makePdf(12, true);
    expect(withObjStm.includes('/ObjStm')).toBe(true);
    expect(await inspectPdfBuffer(withObjStm)).toEqual({ pageCount: 12 });
  });

  it('accepts a stream and a file path', async () => {
    const pdf = await makePdf(3);
    expect(await inspectPdf(Readable.from([pdf]))).toEqual({ pageCount: 3 });
    const f = path.join(dir, 'f.pdf');
    writeFileSync(f, pdf);
    expect(await inspectPdf(f)).toEqual({ pageCount: 3 });
  });

  it('rejects encrypted PDFs', async () => {
    await expect(inspectPdfBuffer(makeEncryptedPdf())).rejects.toMatchObject({ code: 'PASSWORD_PROTECTED_PDF' });
  });

  it('rejects truncated, corrupt and non-PDF content', async () => {
    await expect(inspectPdfBuffer(await makeTruncatedPdf())).rejects.toMatchObject({ code: 'INVALID_PDF' });
    await expect(inspectPdfBuffer(Buffer.from('%PDF-1.7\n' + 'garbage '.repeat(50) + '\n%%EOF\n'))).rejects.toMatchObject({ code: 'INVALID_PDF' });
    await expect(inspectPdfBuffer(makeExe())).rejects.toMatchObject({ code: 'INVALID_PDF' });
    await expect(inspectPdfBuffer(Buffer.alloc(0))).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('enforces the page cap', async () => {
    await expect(inspectPdfBuffer(await makePdf(6), { maxPages: 5 })).rejects.toMatchObject({ code: 'PDF_TOO_MANY_PAGES' });
    expect(await inspectPdfBuffer(await makePdf(5), { maxPages: 5 })).toEqual({ pageCount: 5 });
  });

  it('bounds memory read: refuses streams above maxBytes', async () => {
    await expect(inspectPdf(Readable.from([Buffer.alloc(5000, 1)]), { maxBytes: 1000 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('terminates on timeout', async () => {
    await expect(inspectPdfBuffer(await makePdf(50, false), { timeoutMs: 1 })).rejects.toMatchObject({ code: 'INVALID_PDF' });
  });
});

describe('stored object detection', () => {
  it('detects PDF/PNG/JPEG by magic bytes and reports pageCount', async () => {
    expect(await inspect(await makePdf(2))).toEqual({ mime: 'application/pdf', pageCount: 2 });
    expect(await inspect(makePng(10, 20))).toEqual({ mime: 'image/png', pageCount: 1 });
    expect(await inspect(makeJpeg(30, 40))).toEqual({ mime: 'image/jpeg', pageCount: 1 });
  });

  it('rejects unsupported types and empty files', async () => {
    await expect(inspect(makeExe())).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(inspect(Buffer.from('GIF89a......'))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(inspectStoredObject(storage, generateObjectKey(), 0, { maxPdfPages: 5 })).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('rejects decompression-bomb dimensions and truncated images', async () => {
    await expect(inspect(makePng(30_000, 10))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(inspect(makePng(15_000, 15_000))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' }); // 225 MP
    await expect(inspect(makePng(0, 5))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(inspect(makeJpeg(65_000, 65_000))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    const png = makePng();
    await expect(inspect(png.subarray(0, png.length - 5))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    const jpg = makeJpeg();
    await expect(inspect(jpg.subarray(0, jpg.length - 10))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(inspect(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
  });

  it('accepts the maximum allowed dimensions boundary', async () => {
    expect(await inspect(makePng(10_000, 10_000))).toMatchObject({ mime: 'image/png' });
  });
});
