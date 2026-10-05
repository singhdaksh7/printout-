import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pumpLimited } from './pump.js';
import { assertKey, hmacHex, safeEqualHex } from './keys.js';
import { MAX_PRESIGN_SECONDS, StorageError, type Storage } from './types.js';

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

  /** The signature also covers the disposition: an inline link cannot be turned into a download link (or vice versa). */
  private signRead(key: string, exp: number, disposition: 'inline' | 'attachment' = 'inline'): string {
    return hmacHex(this.secret, disposition === 'attachment' ? `doc:${key}:${exp}:attachment` : `doc:${key}:${exp}`);
  }

  /** Constant-time signature check plus expiry check (exp is unix seconds). */
  verifyRead(key: string, exp: number, sig: string, nowMs = Date.now(), disposition: 'inline' | 'attachment' = 'inline'): boolean {
    if (!Number.isSafeInteger(exp) || exp * 1000 <= nowMs) return false;
    return safeEqualHex(sig, this.signRead(key, exp, disposition));
  }

  async temporaryReadUrl(key: string, expiresSeconds: number, opts?: { disposition?: 'inline' | 'attachment' }) {
    assertKey(key);
    const seconds = Math.min(MAX_PRESIGN_SECONDS, Math.max(1, Math.floor(expiresSeconds)));
    const exp = Math.floor(Date.now() / 1000) + seconds;
    const disposition = opts?.disposition ?? 'inline';
    const dl = disposition === 'attachment' ? '&dl=1' : '';
    return { url: `${this.urlPrefix}/internal/documents/${key}?exp=${exp}${dl}&sig=${this.signRead(key, exp, disposition)}`, expiresAt: new Date(exp * 1000) };
  }
}
