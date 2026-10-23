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

/** Identity proven by a verified Firebase Google ID token (provider google.com). `email` is Google-verified and lowercased. */
export interface VerifiedGoogle {
  uid: string;
  email: string;
  authTime: Date;
}

export type VerifiedIdentity = ({ provider: 'phone' } & VerifiedPhone) | ({ provider: 'google' } & VerifiedGoogle);

export interface PhoneTokenVerifier {
  /** Throws PhoneTokenInvalidError or PhoneVerifierUnavailableError. */
  verify(idToken: string): Promise<VerifiedPhone>;
  /** Google (provider google.com) token with a Google-verified email. Absent on verifiers that do not support Google. */
  verifyGoogle?(idToken: string): Promise<VerifiedGoogle>;
  /** Either a phone or a Google token (used to re-authenticate with a fresh token of an already-linked identity). */
  verifyAny?(idToken: string): Promise<VerifiedIdentity>;
  /** Best effort: revoke the Firebase refresh tokens of a phone user (after unlink/replace). Never throws. */
  revokeSessions(uid: string): Promise<void>;
}

export const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Masks an email for display/audit: keeps the first character and the domain, e.g. r***@gmail.com. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

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
    email?: string;
    email_verified?: boolean;
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

  /** SDK verification (signature/issuer/audience/expiry/revocation) plus the identity-agnostic rules: project, uid, OTP/sign-in freshness. */
  private async decode(idToken: string) {
    if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4096) throw new PhoneTokenInvalidError('shape');
    let decoded: Awaited<ReturnType<AuthLike['verifyIdToken']>>;
    try {
      decoded = await this.auth.verifyIdToken(idToken, this.opts.checkRevoked);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && INVALID_CODES.has(code)) throw new PhoneTokenInvalidError(code);
      throw new PhoneVerifierUnavailableError();
    }
    const { projectId, maxAgeSeconds } = this.opts;
    const nowSeconds = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    if (decoded.aud !== projectId || decoded.iss !== `https://securetoken.google.com/${projectId}`) throw new PhoneTokenInvalidError('project');
    const uid = decoded.uid || decoded.sub;
    if (!uid || uid.length > 128) throw new PhoneTokenInvalidError('uid');
    if (typeof decoded.auth_time !== 'number' || decoded.auth_time > nowSeconds + 60 || nowSeconds - decoded.auth_time > maxAgeSeconds) {
      throw new PhoneTokenInvalidError('stale');
    }
    return { decoded, uid, authTime: new Date(decoded.auth_time * 1000) };
  }

  private phoneFrom(d: Awaited<ReturnType<FirebasePhoneVerifier['decode']>>): VerifiedPhone {
    const phone = d.decoded.phone_number;
    if (typeof phone !== 'string' || !E164.test(phone)) throw new PhoneTokenInvalidError('phone');
    if (!this.opts.allowedCallingCodes.some((code) => phone.startsWith(code))) throw new PhoneTokenInvalidError('region');
    return { uid: d.uid, phoneE164: phone, authTime: d.authTime };
  }

  private googleFrom(d: Awaited<ReturnType<FirebasePhoneVerifier['decode']>>): VerifiedGoogle {
    // Only a Google-VERIFIED address is an identity: an unverified email claim is never trusted.
    const email = d.decoded.email;
    if (typeof email !== 'string' || email.length < 3 || email.length > 254 || !email.includes('@') || d.decoded.email_verified !== true) throw new PhoneTokenInvalidError('email');
    return { uid: d.uid, email: email.toLowerCase(), authTime: d.authTime };
  }

  async verify(idToken: string): Promise<VerifiedPhone> {
    const d = await this.decode(idToken);
    if (d.decoded.firebase?.sign_in_provider !== 'phone') throw new PhoneTokenInvalidError('provider');
    return this.phoneFrom(d);
  }

  async verifyGoogle(idToken: string): Promise<VerifiedGoogle> {
    const d = await this.decode(idToken);
    if (d.decoded.firebase?.sign_in_provider !== 'google.com') throw new PhoneTokenInvalidError('provider');
    return this.googleFrom(d);
  }

  async verifyAny(idToken: string): Promise<VerifiedIdentity> {
    const d = await this.decode(idToken);
    const provider = d.decoded.firebase?.sign_in_provider;
    if (provider === 'phone') return { provider: 'phone', ...this.phoneFrom(d) };
    if (provider === 'google.com') return { provider: 'google', ...this.googleFrom(d) };
    throw new PhoneTokenInvalidError('provider');
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

/** The shared Admin SDK app (phone verification and FCM use the same project and Application Default Credentials). */
export function firebaseAdminApp(projectId: string): App {
  return getApps().some((a) => a.name === APP_NAME) ? getApp(APP_NAME) : initializeApp({ projectId }, APP_NAME);
}

/** Builds the real verifier, or null when FIREBASE_PROJECT_ID is unset (phone sign-in disabled). */
export function createPhoneVerifier(config: Config): PhoneTokenVerifier | null {
  if (!config.FIREBASE_PROJECT_ID) return null;
  const app: App = firebaseAdminApp(config.FIREBASE_PROJECT_ID);
  return new FirebasePhoneVerifier(getAuth(app), {
    projectId: config.FIREBASE_PROJECT_ID,
    maxAgeSeconds: config.FIREBASE_AUTH_MAX_AGE_SECONDS,
    checkRevoked: config.FIREBASE_CHECK_REVOKED,
    allowedCallingCodes: config.PHONE_ALLOWED_CALLING_CODES
  });
}
