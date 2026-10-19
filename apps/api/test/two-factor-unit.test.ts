import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildKeyring, keyIdOf, openSecret, sealSecret, TwoFactorKeyError } from '../src/two-factor/crypto.js';
import {
  findMatchingRecoveryCode,
  generateRecoveryCode,
  hashRecoveryCode,
  normaliseRecoveryCode
} from '../src/two-factor/recovery.js';
import {
  base32Decode,
  base32Encode,
  formatManualKey,
  generateTotpSecret,
  hotp,
  matchTotp,
  normaliseTotpCode,
  otpauthUri,
  timeStep,
  totpAt
} from '../src/two-factor/totp.js';

const key = (byte: number) => Buffer.alloc(32, byte).toString('base64');

describe('TOTP (RFC 4226 / RFC 6238)', () => {
  const rfcSecret = Buffer.from('12345678901234567890');

  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(rfcSecret, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 vectors (8 digits)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130']
    ];
    for (const [seconds, code] of vectors) expect(totpAt(rfcSecret, seconds * 1000, 8)).toBe(code);
  });

  it('round-trips base32 and generates 160-bit secrets', () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBe(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
    expect(() => base32Decode('not*base32')).toThrow();
    expect(generateTotpSecret().equals(generateTotpSecret())).toBe(false);
    expect(formatManualKey(secret)).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
  });

  it('builds a standard otpauth URI', () => {
    const uri = otpauthUri({ secret: rfcSecret, accountName: 'admin+ops@x.test', issuer: 'Printout Buddy' });
    expect(uri).toBe(
      'otpauth://totp/Printout%20Buddy:admin%2Bops%40x.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Printout%20Buddy&algorithm=SHA1&digits=6&period=30'
    );
  });

  describe('clock-skew window', () => {
    const now = 1_700_000_015_000; // mid-step
    const step = timeStep(now);
    const codeFor = (s: number) => hotp(rfcSecret, s);

    it('accepts the current step and one step either side, and reports which step matched', () => {
      expect(matchTotp(rfcSecret, codeFor(step), now)).toBe(step);
      expect(matchTotp(rfcSecret, codeFor(step - 1), now)).toBe(step - 1);
      expect(matchTotp(rfcSecret, codeFor(step + 1), now)).toBe(step + 1);
    });

    it('rejects two steps either side (expired / not yet valid)', () => {
      expect(matchTotp(rfcSecret, codeFor(step - 2), now)).toBeNull();
      expect(matchTotp(rfcSecret, codeFor(step + 2), now)).toBeNull();
    });

    it('moves the boundary exactly at the step edge', () => {
      const edge = step * 30_000; // first millisecond of the step
      expect(matchTotp(rfcSecret, codeFor(step - 2), edge - 1)).toBe(step - 2); // still the previous step's neighbour
      expect(matchTotp(rfcSecret, codeFor(step - 2), edge)).toBeNull(); // one millisecond later it has expired
      expect(matchTotp(rfcSecret, codeFor(step + 1), edge)).toBe(step + 1);
      expect(matchTotp(rfcSecret, codeFor(step + 1), edge - 1)).toBeNull(); // not yet valid one millisecond earlier
      expect(matchTotp(rfcSecret, codeFor(step - 1), edge + 30_000)).toBeNull();
    });

    it('accepts human formatting but nothing else', () => {
      const code = codeFor(step);
      expect(matchTotp(rfcSecret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(step);
      expect(matchTotp(rfcSecret, `${code.slice(0, 3)}-${code.slice(3)}`, now)).toBe(step);
      for (const bad of ['', '12345', '1234567', 'abcdef', `${code}x`, '１２３４５６']) expect(matchTotp(rfcSecret, bad, now)).toBeNull();
      expect(normaliseTotpCode(' 123 456 ')).toBe('123456');
    });
  });
});

describe('secret encryption at rest (AES-256-GCM)', () => {
  const ring = buildKeyring(key(1));

  it('seals and opens, never exposing the plaintext, with a fresh IV each time', () => {
    const secret = generateTotpSecret();
    const a = sealSecret(ring, 'user-1', secret);
    const b = sealSecret(ring, 'user-1', secret);
    expect(a.sealed).not.toBe(b.sealed);
    expect(a.sealed.startsWith(`v1.${ring.primary.id}.`)).toBe(true);
    for (const needle of [secret.toString('hex'), secret.toString('base64'), secret.toString('base64url'), base32Encode(secret)]) {
      expect(a.sealed).not.toContain(needle);
    }
    expect(openSecret(ring, 'user-1', a.sealed).equals(secret)).toBe(true);
  });

  it('refuses another user, a wrong key, tampering and malformed blobs', () => {
    const { sealed } = sealSecret(ring, 'user-1', generateTotpSecret());
    expect(() => openSecret(ring, 'user-2', sealed)).toThrow();
    expect(() => openSecret(buildKeyring(key(2)), 'user-1', sealed)).toThrow(TwoFactorKeyError);
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => openSecret(ring, 'user-1', [...parts.slice(0, 3), flipped.toString('base64url'), parts[4]].join('.'))).toThrow();
    expect(() => openSecret(ring, 'user-1', [...parts.slice(0, 4), 'AAAA'].join('.'))).toThrow();
    for (const bad of ['', 'v1', 'v2.a.b.c.d', 'garbage']) expect(() => openSecret(ring, 'user-1', bad)).toThrow();
  });

  it('opens old-key data during rotation and always seals with the primary key', () => {
    const oldRing = buildKeyring(key(1));
    const { sealed } = sealSecret(oldRing, 'u', Buffer.from('s3cret'));
    const rotated = buildKeyring(key(2), key(1));
    expect(rotated.primary.id).toBe(keyIdOf(Buffer.alloc(32, 2)));
    expect(openSecret(rotated, 'u', sealed).toString()).toBe('s3cret');
    expect(sealSecret(rotated, 'u', Buffer.from('x')).keyId).toBe(rotated.primary.id);
  });

  it('rejects malformed keys without echoing them', () => {
    for (const bad of ['', 'short', Buffer.alloc(16, 1).toString('base64')]) {
      try {
        buildKeyring(bad);
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TwoFactorKeyError);
        expect((error as Error).message).not.toContain(bad || 'x-never');
      }
    }
  });
});

describe('recovery codes', () => {
  it('are random, well formed and canonicalised', () => {
    const codes = new Set(Array.from({ length: 200 }, generateRecoveryCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    const code = [...codes][0]!;
    expect(normaliseRecoveryCode(code.toLowerCase().replace('-', ' '))).toBe(code.replace('-', ''));
    for (const bad of ['', 'ABCDE', 'ABCDE-FGHIO', 'ABCDE-FGHI1', 'ABCDE-FGHIJK']) expect(normaliseRecoveryCode(bad)).toBeNull();
  });

  it('are stored only as Argon2id hashes and match case/format-insensitively', async () => {
    const code = generateRecoveryCode();
    const other = generateRecoveryCode();
    const hashes = [await hashRecoveryCode(other), await hashRecoveryCode(code)];
    for (const h of hashes) {
      expect(h).toMatch(/^\$argon2id\$/);
      expect(h).not.toContain(code.replace('-', ''));
    }
    expect(await findMatchingRecoveryCode(hashes, code)).toBe(1);
    expect(await findMatchingRecoveryCode(hashes, code.toLowerCase())).toBe(1);
    expect(await findMatchingRecoveryCode(hashes, code.replace('-', ' '))).toBe(1);
    expect(await findMatchingRecoveryCode(hashes, generateRecoveryCode())).toBe(-1);
    expect(await findMatchingRecoveryCode(hashes, 'not a code')).toBe(-1);
    expect(await findMatchingRecoveryCode([], code)).toBe(-1);
  });
});

describe('configuration', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/printout_test',
    SESSION_SECRET: 'test-session-secret-0123456789abcdefghij',
    CSRF_SECRET: 'test-csrf-secret-0123456789abcdefghijk'
  };

  it('is optional, and validates the key when given', () => {
    expect(loadConfig(base).TWO_FACTOR_ENCRYPTION_KEY).toBeUndefined();
    expect(loadConfig({ ...base, TWO_FACTOR_ENCRYPTION_KEY: key(3) }).TWO_FACTOR_CHALLENGE_TTL_SECONDS).toBe(300);
    expect(() => loadConfig({ ...base, TWO_FACTOR_ENCRYPTION_KEY: 'too-short' })).toThrow(/TWO_FACTOR_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...base, TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS: key(3) })).toThrow(/requires TWO_FACTOR_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...base, TWO_FACTOR_ENCRYPTION_KEY: key(3), TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS: 'nope' })).toThrow(/PREVIOUS/);
  });

  it('config errors never include the key value', () => {
    try {
      loadConfig({ ...base, TWO_FACTOR_ENCRYPTION_KEY: 'super-secret-but-malformed' });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-but-malformed');
    }
  });
});
