import { getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { Config } from '../config.js';

/** Identity proven by a verified Firebase phone ID token. Never contains the token itself. */
export interface VerifiedPhone {
  /** Firebase UID of the phone user. */
  uid: string;
  /** E.164, e.g. +919876543210. */
  phoneE164: string;
  /** Instant the OTP was verified (Firebase `auth_time`). A fresh OTP always yields a later value. */
  authTime: Date;
}

/** The token is not acceptable (forged, tampered, expired, wrong project/provider, too old, revoked, disallowed region). */
export class PhoneTokenInvalidError extends Error {
  constructor(public readonly reason: string) {
    super('phone token invalid');
    this.name = 'PhoneTokenInvalidError';
  }
}
/** Firebase (or our credentials for it) could not be reached/used. Fail closed; the caller answers 503. */
export class PhoneVerifierUnavailableError extends Error {
  constructor() {
    super('phone verification unavailable');
    this.name = 'PhoneVerifierUnavailableError';
  }
}

export interface PhoneTokenVerifier {
  /** Throws PhoneTokenInvalidError or PhoneVerifierUnavailableError. */
  verify(idToken: string): Promise<VerifiedPhone>;
  /** Best effort: revoke the Firebase refresh tokens of a phone user (after unlink/replace). Never throws. */
  revokeSessions(uid: string): Promise<void>;
}

export const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Masks a number for display/audit: keeps the calling code and the last 2 digits, e.g. +91••••••••10. */
export function maskPhone(e164: string): string {
  const keep = e164.slice(-2);
  return `${e164.slice(0, Math.min(3, e164.length - 2))}${'•'.repeat(Math.max(0, e164.length - 5))}${keep}`;
}

/** The subset of the Admin SDK Auth API this module needs (lets tests stub the SDK). */
export interface AuthLike {
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<{
    aud: string;
    iss: string;
    sub: string;
    uid: string;
    auth_time: number;
    exp: number;
    phone_number?: string;
    firebase?: { sign_in_provider?: string };
  }>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

const INVALID_CODES = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/user-disabled',
  'auth/user-not-found'
]);

export interface VerifierOptions {
  projectId: string;
  maxAgeSeconds: number;
  checkRevoked: boolean;
  allowedCallingCodes: readonly string[];
  now?: () => number;
}

/**
 * Wraps the Admin SDK: the SDK checks signature, issuer, audience, expiry and subject; this class re-asserts project
 * identity and adds the phone-specific rules (provider, E.164, allowed region, OTP freshness).
 */
export class FirebasePhoneVerifier implements PhoneTokenVerifier {
  constructor(
    private readonly auth: AuthLike,
    private readonly opts: VerifierOptions
  ) {}

  async verify(idToken: string): Promise<VerifiedPhone> {
    if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4096) throw new PhoneTokenInvalidError('shape');
    let decoded: Awaited<ReturnType<AuthLike['verifyIdToken']>>;
    try {
      decoded = await this.auth.verifyIdToken(idToken, this.opts.checkRevoked);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && INVALID_CODES.has(code)) throw new PhoneTokenInvalidError(code);
      throw new PhoneVerifierUnavailableError();
    }
    const { projectId, maxAgeSeconds, allowedCallingCodes } = this.opts;
    const nowSeconds = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    if (decoded.aud !== projectId || decoded.iss !== `https://securetoken.google.com/${projectId}`) throw new PhoneTokenInvalidError('project');
    if (decoded.firebase?.sign_in_provider !== 'phone') throw new PhoneTokenInvalidError('provider');
    const uid = decoded.uid || decoded.sub;
    if (!uid || uid.length > 128) throw new PhoneTokenInvalidError('uid');
    const phone = decoded.phone_number;
    if (typeof phone !== 'string' || !E164.test(phone)) throw new PhoneTokenInvalidError('phone');
    if (!allowedCallingCodes.some((code) => phone.startsWith(code))) throw new PhoneTokenInvalidError('region');
    if (typeof decoded.auth_time !== 'number' || decoded.auth_time > nowSeconds + 60 || nowSeconds - decoded.auth_time > maxAgeSeconds) {
      throw new PhoneTokenInvalidError('stale');
    }
    return { uid, phoneE164: phone, authTime: new Date(decoded.auth_time * 1000) };
  }

  async revokeSessions(uid: string): Promise<void> {
    try {
      await this.auth.revokeRefreshTokens(uid);
    } catch {
      /* best effort: the local identity is already gone, so these tokens can no longer sign anyone in */
    }
  }
}

const APP_NAME = 'printout-phone-auth';

/** Builds the real verifier, or null when FIREBASE_PROJECT_ID is unset (phone sign-in disabled). */
export function createPhoneVerifier(config: Config): PhoneTokenVerifier | null {
  if (!config.FIREBASE_PROJECT_ID) return null;
  const app: App = getApps().some((a) => a.name === APP_NAME) ? getApp(APP_NAME) : initializeApp({ projectId: config.FIREBASE_PROJECT_ID }, APP_NAME);
  return new FirebasePhoneVerifier(getAuth(app), {
    projectId: config.FIREBASE_PROJECT_ID,
    maxAgeSeconds: config.FIREBASE_AUTH_MAX_AGE_SECONDS,
    checkRevoked: config.FIREBASE_CHECK_REVOKED,
    allowedCallingCodes: config.PHONE_ALLOWED_CALLING_CODES
  });
}
