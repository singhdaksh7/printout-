import type { Prisma, PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { AppError } from '../errors.js';
import type { AppContext } from '../routes/context.js';
import { openSecret, type TwoFactorKeyring } from './crypto.js';
import { findMatchingRecoveryCode, generateRecoveryCode, hashRecoveryCode, RECOVERY_CODE_COUNT } from './recovery.js';
import { matchTotp } from './totp.js';

export const TWO_FACTOR_ISSUER = 'Printout Buddy';
/** An enrollment that was started but not confirmed within this window must be restarted. */
export const ENROLLMENT_TTL_MS = 15 * 60_000;

export type SecondFactorMethod = 'totp' | 'recovery';
export type SecondFactorFailure = 'invalid' | 'replay';
export type SecondFactorOutcome =
  | { ok: true; method: SecondFactorMethod; recoveryCodesRemaining?: number }
  | { ok: false; method: SecondFactorMethod; reason: SecondFactorFailure };

export const unavailable = () =>
  new AppError(503, 'TWO_FACTOR_UNAVAILABLE', 'Two-factor authentication is not available on this server right now. Contact the platform operator.');

export function requireKeys(ctx: AppContext): TwoFactorKeyring {
  if (!ctx.twoFactorKeys) throw unavailable();
  return ctx.twoFactorKeys;
}

/** Per-admin budget for wrong second-factor answers (shared by sign-in, disable and regenerate). In memory, per process. */
export const secondFactorKey = (userId: string): string => `2fa|${userId}`;
export const secondFactorMax = (ctx: AppContext): number => ctx.config.LOGIN_FAIL_MAX * 2;

export function assertSecondFactorNotThrottled(ctx: AppContext, userId: string): void {
  if (ctx.loginThrottle.isBlocked(secondFactorKey(userId), Date.now(), secondFactorMax(ctx))) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many incorrect codes. Try again later.');
  }
}

/** Binds a pending sign-in to the credentials it was issued for: changing the password voids it. */
export const credentialFingerprint = (ctx: AppContext, passwordHash: string): string =>
  createHmac('sha256', ctx.config.SESSION_SECRET).update('printout:2fa:credfp:').update(passwordHash).digest('hex');

/** Throws 503 (never a bypass) when a stored secret cannot be opened with the configured keys. */
export function openUserSecret(ctx: AppContext, userId: string, sealed: string): Buffer {
  try {
    return openSecret(requireKeys(ctx), userId, sealed);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

/**
 * Checks a TOTP code or recovery code for an admin with ENABLED two-factor and consumes it atomically:
 * - TOTP: accepted only for a time-step strictly greater than `lastUsedStep`; the counter is advanced with a conditional
 *   UPDATE, so of any number of concurrent requests carrying the same code exactly one succeeds (replay protection).
 * - Recovery: the code row is marked used with a conditional UPDATE; a code works exactly once.
 * Callers own throttling, auditing and what happens next.
 */
export async function consumeSecondFactor(
  ctx: AppContext,
  userId: string,
  input: { method: SecondFactorMethod; code: string }
): Promise<SecondFactorOutcome> {
  const { prisma } = ctx;
  const row = await prisma.adminTwoFactor.findUnique({ where: { userId } });
  if (!row?.enabledAt) return { ok: false, method: input.method, reason: 'invalid' };

  if (input.method === 'totp') {
    const secret = openUserSecret(ctx, userId, row.secretEnc);
    const step = matchTotp(secret, input.code, Date.now());
    if (step === null) return { ok: false, method: 'totp', reason: 'invalid' };
    const advanced = await prisma.adminTwoFactor.updateMany({
      where: { userId, enabledAt: { not: null }, lastUsedStep: { lt: BigInt(step) } },
      data: { lastUsedStep: BigInt(step) }
    });
    return advanced.count === 1 ? { ok: true, method: 'totp' } : { ok: false, method: 'totp', reason: 'replay' };
  }

  const codes = await prisma.adminRecoveryCode.findMany({ where: { userId, usedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, codeHash: true } });
  const index = await findMatchingRecoveryCode(codes.map((c) => c.codeHash), input.code);
  if (index < 0) return { ok: false, method: 'recovery', reason: 'invalid' };
  const used = await prisma.adminRecoveryCode.updateMany({ where: { id: codes[index]!.id, usedAt: null }, data: { usedAt: new Date() } });
  if (used.count !== 1) return { ok: false, method: 'recovery', reason: 'replay' };
  return { ok: true, method: 'recovery', recoveryCodesRemaining: await prisma.adminRecoveryCode.count({ where: { userId, usedAt: null } }) };
}

/** Hashes a fresh batch (expensive, so done BEFORE a transaction is opened). */
export async function prepareRecoveryCodes(): Promise<{ plain: string[]; hashes: string[] }> {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  return { plain, hashes: await Promise.all(plain.map(hashRecoveryCode)) };
}

/** Replaces ALL of the admin's recovery codes with the prepared batch (old codes stop working immediately). */
export async function storeRecoveryCodes(tx: Prisma.TransactionClient | PrismaClient, userId: string, hashes: string[]): Promise<void> {
  await tx.adminRecoveryCode.deleteMany({ where: { userId } });
  await tx.adminRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) });
}
