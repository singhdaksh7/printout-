import { randomInt } from 'node:crypto';
import { hashPassword, verifyPassword } from '../auth.js';

/**
 * Recovery codes: 10 characters from a 31-symbol alphabet without look-alikes (about 49.5 bits), shown as XXXXX-XXXXX.
 * At rest only an Argon2id hash exists. Matching verifies the admin's remaining unused hashes (at most RECOVERY_CODE_COUNT).
 */
export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
const LENGTH = 10;

export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Canonical form for hashing and comparing: upper case, separators/spaces removed. Null when it cannot be a code. */
export function normaliseRecoveryCode(input: string): string | null {
  const raw = input.replace(/[\s-]/g, '').toUpperCase();
  return raw.length === LENGTH && [...raw].every((c) => ALPHABET.includes(c)) ? raw : null;
}

export const hashRecoveryCode = (code: string): Promise<string> => hashPassword(normaliseRecoveryCode(code) ?? code);

/** Index of the matching hash or -1. Every candidate is verified (no early exit on the first match). */
export async function findMatchingRecoveryCode(hashes: string[], input: string): Promise<number> {
  const raw = normaliseRecoveryCode(input);
  if (!raw) return -1;
  let found = -1;
  for (let i = 0; i < hashes.length; i++) if (await verifyPassword(hashes[i]!, raw)) found = i;
  return found;
}
