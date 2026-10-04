import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pumpLimited } from './pump.js';
import { assertKey, hmacHex, safeEqualHex } from './keys.js';
import { StorageError, type Storage } from './types.js';

export class LocalStorage implements Storage {
  private readonly root: string;
  private readonly tmpDir: string;
  private readonly secret: Buffer;
  private readonly urlPrefix: string;

  constructor(directory: string, secret?: Buffer | string, urlPrefix = '/api/v1') {
    this.root = path.resolve(directory);
    this.tmpDir = path.join(this.root, '.tmp');
    this.secret = secret ? Buffer.from(secret) : randomBytes(32);
    this.urlPrefix = urlPrefix.replace(/\/$/, '');
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
  }

  /** Resolve a key to an absolute path, refusing anything outside the root. */
  private file(key: string): string {
    assertKey(key);
    const full = path.resolve(this.root, key);
    if (path.dirname(full) !== this.root) throw new StorageError('INVALID_KEY', 'Invalid object key');
    return full;
  }

  async put(key: string, body: NodeJS.ReadableStream, opts: { maxBytes: number; contentType?: string }) {
    const final = this.file(key);
    await fs.mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.tmpDir, randomBytes(16).toString('hex'));
    const hash = createHash('sha256');
    const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    let size = 0;
    try {
      size = await pumpLimited(body, out, opts.maxBytes, (c) => hash.update(c));
      try {
        await fs.link(tmp, final); // atomic, refuses to overwrite an existing object
      } catch (e: any) {
        if (e?.code === 'EEXIST') throw new StorageError('KEY_EXISTS', 'Object already exists');
        throw e;
      }
    } catch (e) {
      out.destroy();
      await new Promise<void>((r) => (out.closed ? r() : out.once('close', () => r())));
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
    await fs.unlink(tmp).catch(() => undefined);
    return { size, sha256: hash.digest('hex') };
  }

  async head(key: string) {
    try {
      const st = await fs.stat(this.file(key));
      return st.isFile() ? { size: st.size } : null;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async exists(key: string) {
    return (await this.head(key)) !== null;
  }

  async openRead(key: string, range?: { start: number; end: number }) {
    const file = this.file(key);
    await fs.access(file); // surfaces ENOENT eagerly
    return createReadStream(file, range ? { start: range.start, end: range.end } : undefined);
  }

  async delete(key: string) {
    try {
      await fs.unlink(this.file(key));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }

  private signRead(key: string, exp: number): string {
    return hmacHex(this.secret, `doc:${key}:${exp}`);
  }

  /** Constant-time signature check plus expiry check (exp is unix seconds). */
  verifyRead(key: string, exp: number, sig: string, nowMs = Date.now()): boolean {
    if (!Number.isSafeInteger(exp) || exp * 1000 <= nowMs) return false;
    return safeEqualHex(sig, this.signRead(key, exp));
  }

  async temporaryReadUrl(key: string, expiresSeconds: number) {
    assertKey(key);
    const seconds = Math.max(1, Math.floor(expiresSeconds));
    const exp = Math.floor(Date.now() / 1000) + seconds;
    return { url: `${this.urlPrefix}/internal/documents/${key}?exp=${exp}&sig=${this.signRead(key, exp)}`, expiresAt: new Date(exp * 1000) };
  }
}
