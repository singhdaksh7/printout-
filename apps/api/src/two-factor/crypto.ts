import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for TOTP secrets at rest: AES-256-GCM, a fresh 96-bit IV per seal, and the owning user id
 * bound in as additional authenticated data (a ciphertext copied to another user's row fails to open).
 *
 * Stored form: `v1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url). The key is TWO_FACTOR_ENCRYPTION_KEY (32 random bytes,
 * base64); it is independent of SESSION_SECRET / CSRF_SECRET so it can be rotated separately. Rotation keeps the old
 * key in TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS (comma list) until every row has been re-sealed (`admin:2fa-rekey`).
 */
export interface TwoFactorKeyring {
  primary: { id: string; key: Buffer };
  all: Map<string, Buffer>;
}

export class TwoFactorKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwoFactorKeyError';
  }
}

export const keyIdOf = (key: Buffer): string => createHash('sha256').update('printout:2fa:keyid:').update(key).digest('hex').slice(0, 12);

function parseKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new TwoFactorKeyError(`${label} must be 32 random bytes encoded as base64 (generate with: openssl rand -base64 32)`);
  return key;
}

/** Throws TwoFactorKeyError (never echoing key material) when a configured value is malformed. */
export function buildKeyring(primaryRaw: string, previousRaw?: string): TwoFactorKeyring {
  const primary = parseKey(primaryRaw, 'TWO_FACTOR_ENCRYPTION_KEY');
  const all = new Map<string, Buffer>([[keyIdOf(primary), primary]]);
  for (const part of (previousRaw ?? '').split(',').filter((p) => p.trim())) {
    const key = parseKey(part, 'TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS');
    all.set(keyIdOf(key), key);
  }
  return { primary: { id: keyIdOf(primary), key: primary }, all };
}

const aad = (userId: string): Buffer => Buffer.from(`printout:2fa:secret:${userId}`);

export function sealSecret(ring: TwoFactorKeyring, userId: string, plaintext: Buffer): { sealed: string; keyId: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.primary.key, iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b = (x: Buffer) => x.toString('base64url');
  return { sealed: ['v1', ring.primary.id, b(iv), b(ct), b(tag)].join('.'), keyId: ring.primary.id };
}

/** Throws when the key is unknown or the blob was tampered with / belongs to another user. */
export function openSecret(ring: TwoFactorKeyring, userId: string, sealed: string): Buffer {
  const [version, keyId, iv, ct, tag] = sealed.split('.');
  const key = keyId ? ring.all.get(keyId) : undefined;
  if (version !== 'v1' || !key || !iv || !ct || !tag) throw new TwoFactorKeyError('two-factor secret cannot be opened with the configured keys');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}
