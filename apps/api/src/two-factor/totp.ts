import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step): the profile every authenticator app implements by default.
 * Secrets are 160-bit random values, shown to the admin as RFC 4648 base32.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accepted drift: +-1 step (30 s each way) tolerates ordinary clock skew without a wide guess window. */
export const TOTP_SKEW_STEPS = 1;
const SECRET_BYTES = 20;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const generateTotpSecret = (): Buffer => randomBytes(SECRET_BYTES);

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const timeStep = (nowMs: number, stepSeconds = TOTP_STEP_SECONDS): number => Math.floor(nowMs / 1000 / stepSeconds);

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpAt = (secret: Buffer, nowMs: number, digits = TOTP_DIGITS): string => hotp(secret, timeStep(nowMs), digits);

const sameCode = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Normalises what a person types ("123 456", "123-456") to the bare digits; anything else is not a TOTP code. */
export function normaliseTotpCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits) ? digits : null;
}

/**
 * Returns the time-step the code belongs to, or null. Every candidate step is compared (no early exit) so timing does
 * not reveal which step matched. The caller must still enforce `step > lastUsedStep` atomically (replay protection).
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, skew = TOTP_SKEW_STEPS): number | null {
  const normalised = normaliseTotpCode(code);
  if (!normalised) return null;
  const current = timeStep(nowMs);
  let matched: number | null = null;
  for (let step = current - skew; step <= current + skew; step++) {
    if (step >= 0 && sameCode(hotp(secret, step), normalised) && (matched === null || step > matched)) matched = step;
  }
  return matched;
}

/** otpauth:// provisioning URI (Key URI Format) used for the QR code. Contains the secret: never log it. */
export function otpauthUri(params: { secret: Buffer; accountName: string; issuer: string }): string {
  const issuer = encodeURIComponent(params.issuer);
  const label = `${issuer}:${encodeURIComponent(params.accountName)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(params.secret)}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** Manual-entry key grouped in fours for readability ("ABCD EFGH ..."). */
export const formatManualKey = (secret: Buffer): string => base32Encode(secret).replace(/(.{4})/g, '$1 ').trim();
