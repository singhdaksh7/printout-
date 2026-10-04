import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { createStorage, generateObjectKey, isValidObjectKey, LocalStorage, StorageError } from '../src/storage/index.js';
import { sanitizeFilename } from '../src/storage/filename.js';

let dir: string;
let storage: LocalStorage;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'printout-st-'));
  storage = new LocalStorage(dir, 'secret-for-tests');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const readAll = async (s: NodeJS.ReadableStream) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
};
const stored = () => readdirSync(dir).filter((f) => f !== '.tmp');

describe('local storage keys', () => {
  it('generates strong keys that match the strict pattern', () => {
    const k = generateObjectKey();
    expect(k).toHaveLength(43);
    expect(isValidObjectKey(k)).toBe(true);
    expect(generateObjectKey()).not.toBe(k);
  });

  it.each(['../../etc/passwd', '..\\..\\windows', 'a/b', 'short', '.hidden-file-name-long-enough', 'x'.repeat(19), 'x'.repeat(129), `${'a'.repeat(30)}/../..`, `${'a'.repeat(30)}%2e%2e`, `${'a'.repeat(30)}\0`, ''])(
    'rejects unsafe key %j on every operation',
    async (key) => {
      await expect(storage.put(key, Readable.from([Buffer.from('x')]), { maxBytes: 10 })).rejects.toBeInstanceOf(StorageError);
      await expect(storage.head(key)).rejects.toBeInstanceOf(StorageError);
      await expect(storage.exists(key)).rejects.toBeInstanceOf(StorageError);
      await expect(storage.openRead(key)).rejects.toBeInstanceOf(StorageError);
      await expect(storage.delete(key)).rejects.toBeInstanceOf(StorageError);
      await expect(storage.temporaryReadUrl(key, 60)).rejects.toBeInstanceOf(StorageError);
    }
  );
});

describe('local storage io', () => {
  it('puts atomically with sha256, supports head/exists/ranges and idempotent delete', async () => {
    const key = generateObjectKey();
    const data = Buffer.from('0123456789abcdef');
    const res = await storage.put(key, Readable.from([data.subarray(0, 5), data.subarray(5)]), { maxBytes: 100, contentType: 'application/pdf' });
    expect(res).toEqual({ size: 16, sha256: createHash('sha256').update(data).digest('hex') });
    expect(await storage.head(key)).toEqual({ size: 16 });
    expect(await storage.exists(key)).toBe(true);
    expect((await readAll(await storage.openRead(key, { start: 2, end: 5 }))).toString()).toBe('2345');
    expect((await readAll(await storage.openRead(key))).toString()).toBe('0123456789abcdef');
    await storage.delete(key);
    await storage.delete(key); // idempotent
    expect(await storage.head(key)).toBeNull();
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.openRead(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to overwrite an existing object', async () => {
    const key = generateObjectKey();
    await storage.put(key, Readable.from([Buffer.from('one')]), { maxBytes: 10 });
    await expect(storage.put(key, Readable.from([Buffer.from('two')]), { maxBytes: 10 })).rejects.toMatchObject({ code: 'KEY_EXISTS' });
    expect((await readAll(await storage.openRead(key))).toString()).toBe('one');
    await storage.delete(key);
  });

  it('aborts when maxBytes is exceeded and leaves no partial file', async () => {
    const before = stored().length;
    const key = generateObjectKey();
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(1000, 1));
    await expect(storage.put(key, Readable.from(chunks), { maxBytes: 3500 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(storage.put(key, Readable.from(chunks), { maxBytes: 3500 })).rejects.toBeInstanceOf(AppError);
    expect(await storage.head(key)).toBeNull();
    expect(stored().length).toBe(before);
    expect(readdirSync(path.join(dir, '.tmp'))).toEqual([]);
  });

  it('streams large bodies without buffering them (bounded memory growth)', async () => {
    const key = generateObjectKey();
    const piece = Buffer.alloc(1024 * 1024, 7);
    const total = 96;
    let peak = 0;
    const base = process.memoryUsage().arrayBuffers;
    async function* gen() {
      for (let i = 0; i < total; i++) {
        peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
        yield piece;
      }
    }
    const res = await storage.put(key, Readable.from(gen(), { objectMode: false }), { maxBytes: 200 * 1024 * 1024 });
    expect(res.size).toBe(total * piece.length);
    expect(peak).toBeLessThan(32 * 1024 * 1024); // buffering the whole 96 MiB would blow well past this
    await storage.delete(key);
  });
});

describe('signed read urls', () => {
  it('signs, verifies, and rejects tampering / expiry / other keys', async () => {
    const key = generateObjectKey();
    const { url, expiresAt } = await storage.temporaryReadUrl(key, 120);
    const u = new URL(url, 'http://x');
    expect(u.pathname).toBe(`/api/v1/internal/documents/${key}`);
    expect(url).not.toContain(dir);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig')!;
    expect(expiresAt.getTime()).toBe(exp * 1000);
    expect(storage.verifyRead(key, exp, sig)).toBe(true);
    expect(storage.verifyRead(key, exp, sig.replace(/.$/, sig.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(storage.verifyRead(key, exp + 1, sig)).toBe(false);
    expect(storage.verifyRead(generateObjectKey(), exp, sig)).toBe(false);
    expect(storage.verifyRead(key, exp, sig, exp * 1000 + 1)).toBe(false); // expired
    expect(storage.verifyRead(key, exp, 'zz')).toBe(false);
    expect(new LocalStorage(dir, 'other-secret').verifyRead(key, exp, sig)).toBe(false);
  });

  it('createStorage builds the local driver from config', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'printout-cs-'));
    const s = createStorage({ STORAGE_DRIVER: 'local', LOCAL_UPLOAD_DIR: d, SESSION_SECRET: 'x'.repeat(32) });
    expect(s).toBeInstanceOf(LocalStorage);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('filename sanitisation', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\bob\\evil.pdf', 'evil.pdf'],
    ['a\u0000b\u0007.pdf', 'ab.pdf'],
    ['  ..hidden.pdf ', 'hidden.pdf'],
    ['re\u202Egpj.exe', 'regpj.exe'],
    ['', 'document'],
    ['///', 'document'],
    ['na<me>|"x".pdf', 'na_me___x_.pdf']
  ])('%j -> %j', (input, expected) => expect(sanitizeFilename(input)).toBe(expected));

  it('bounds length and keeps the extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(400)}.pdf`);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});
