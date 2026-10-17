import argon2 from 'argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

/**
 * ROLLBACK GUARD. While an admin has two-factor enabled, their stored password hash is prefixed with this marker. This API
 * strips it before verifying; an OLDER API (without two-factor support) feeds the marker to argon2, which rejects it, so
 * a downgraded deployment cannot authenticate an enrolled admin with the password alone: it fails closed (the admin is
 * locked out until the new API is back or an operator runs `admin:2fa-reset`). Invariant: wrapped <=> 2FA enabled.
 */
export const TWO_FACTOR_HASH_PREFIX = 'tfa1$';
export const isWrappedHash = (hash: string): boolean => hash.startsWith(TWO_FACTOR_HASH_PREFIX);
export const wrapHash = (hash: string): string => (isWrappedHash(hash) ? hash : TWO_FACTOR_HASH_PREFIX + hash);
export const unwrapHash = (hash: string): string => (isWrappedHash(hash) ? hash.slice(TWO_FACTOR_HASH_PREFIX.length) : hash);
/** A freshly hashed password keeps the account's current wrapping state. */
export const rewrapLike = (current: string, fresh: string): string => (isWrappedHash(current) ? wrapHash(fresh) : fresh);

export const verifyPassword = async (hash: string, password: string): Promise<boolean> => {
  try {
    return await argon2.verify(unwrapHash(hash), password);
  } catch {
    return false;
  }
};

export const newToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export const csrfToken = (secret: string, sessionId: string): string =>
  createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('hex');

export const equalToken = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

let dummyHash: Promise<string> | undefined;
/**
 * Verifies against a throw-away hash so unknown accounts cost the same as wrong passwords
 * (prevents account enumeration by timing).
 */
export function burnPasswordCheck(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash.then((hash) => verifyPassword(hash, password));
}

/** In-memory failed-login throttle keyed by caller-supplied string (IP + email). Per process. */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; first: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  isBlocked(key: string, now = Date.now(), max = this.max): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (now - entry.first > this.windowMs) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= max;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.failures.get(key);
    if (!entry || now - entry.first > this.windowMs) this.failures.set(key, { count: 1, first: now });
    else entry.count += 1;
    if (this.failures.size > 10_000) this.prune(now);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.failures) if (now - entry.first > this.windowMs) this.failures.delete(key);
  }
}
