import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { StorageError, type StorageConfig } from './types.js';

export const KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/** 32 random bytes, base64url (43 chars). */
export const generateObjectKey = (): string => randomBytes(32).toString('base64url');
export const isValidObjectKey = (key: unknown): key is string => typeof key === 'string' && KEY_PATTERN.test(key);
export function assertKey(key: string): void {
  if (!isValidObjectKey(key)) throw new StorageError('INVALID_KEY', 'Invalid object key');
}

/** Domain-separated secret derivation so upload tokens and read signatures never share a key. */
export function deriveSecret(config: Pick<StorageConfig, 'SESSION_SECRET' | 'STORAGE_URL_SECRET'>, label: string): Buffer {
  const base = config.STORAGE_URL_SECRET || config.SESSION_SECRET;
  return createHmac('sha256', base).update(`printout:${label}`).digest();
}

export const hmacHex = (secret: Buffer, message: string): string => createHmac('sha256', secret).update(message).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
