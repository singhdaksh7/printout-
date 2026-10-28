import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { newToken, tokenHash } from '../auth.js';
import { AppError } from '../errors.js';
import { audit, createSession, type AppContext } from '../routes/context.js';
import { issueGrant } from './onboarding-grant.js';

/**
 * Mobile credentials, on the EXISTING Session table (no second session system):
 *   access token  = an opaque Session token (Authorization: Bearer), short lived (ACCESS_TOKEN_TTL_MINUTES);
 *   refresh token = a rotating, single-use credential in a family (REFRESH_TOKEN_TTL_DAYS), stored ONLY as a SHA-256 hash.
 * A verified phone with NO account yet gets the same pair in a restricted form: the access token is a scoped onboarding grant and the
 * refresh token belongs to a family of kind 'onboarding'; once the identity is linked to a user, the next refresh issues the normal pair.
 * They are different secrets from the Firebase ID token, the Firebase-managed refresh token (never seen or stored here) and the FCM token.
 *
 * Rotation is atomic (one UPDATE decides the winner). Presenting a token that was already rotated or revoked is treated as theft:
 * the whole family (every session and refresh token) is revoked. A just-rotated token re-presented within a few seconds is only a
 * client race: 409, nothing is revoked.
 */
export interface MobileCredentials {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

type Db = PrismaClient | Prisma.TransactionClient;

export const REFRESH_INVALID = () => new AppError(401, 'REFRESH_TOKEN_INVALID', 'Your sign-in could not be renewed. Sign in again.');
const REFRESH_EXPIRED = () => new AppError(401, 'REFRESH_TOKEN_EXPIRED', 'Your sign-in expired. Sign in again.');
const REFRESH_CONFLICT = () => new AppError(409, 'REFRESH_CONFLICT', 'A refresh is already in progress. Retry once the first one finishes.');
/** A suspended shop / blocked account gets NO tokens; the app shows the blocked screen from error.details.nextStep. */
export const accountBlocked = () => new AppError(403, 'ACCOUNT_BLOCKED', 'This account is blocked. Contact Printout Buddy support.', { nextStep: 'account_blocked' });

export async function issueMobileCredentials(ctx: AppContext, userId: string, deviceId: string, familyId: string = randomUUID()): Promise<MobileCredentials> {
  const access = await createSession(ctx, userId, { ttlMs: ctx.config.ACCESS_TOKEN_TTL_MINUTES * 60_000, familyId, deviceId });
  const refreshToken = newToken();
  const refreshTokenExpiresAt = new Date(Date.now() + ctx.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await ctx.prisma.refreshToken.create({
    data: { familyId, userId, kind: 'user', tokenHash: tokenHash(refreshToken), sessionId: access.sessionId, deviceId, clientType: 'mobile', expiresAt: refreshTokenExpiresAt }
  });
  return { accessToken: access.raw, accessTokenExpiresAt: access.expiresAt, refreshToken, refreshTokenExpiresAt };
}

export interface Subject {
  provider: 'phone' | 'google';
  uid: string;
  phone?: string | null;
  email?: string | null;
  authTime: Date;
}

/** The restricted pair for a verified phone without an account: scoped grant (access) + onboarding-kind refresh token. */
export async function issueRestrictedCredentials(ctx: AppContext, subject: Subject, deviceId: string, familyId: string = randomUUID()): Promise<MobileCredentials> {
  const grant = await issueGrant(ctx, { provider: subject.provider, firebaseUid: subject.uid, phoneE164: subject.phone ?? null, email: subject.email ?? null, authTime: subject.authTime, mobile: { familyId, deviceId } });
  const refreshToken = newToken();
  const refreshTokenExpiresAt = new Date(Date.now() + ctx.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await ctx.prisma.refreshToken.create({
    data: { familyId, userId: null, kind: 'onboarding', subjectProvider: subject.provider, subjectUid: subject.uid, subjectPhone: subject.phone ?? null, subjectEmail: subject.email ?? null, tokenHash: tokenHash(refreshToken), deviceId, clientType: 'mobile', expiresAt: refreshTokenExpiresAt }
  });
  return { accessToken: grant.raw, accessTokenExpiresAt: grant.expiresAt, refreshToken, refreshTokenExpiresAt };
}

/** Revokes every session, restricted grant and refresh token of one family. Returns how many refresh tokens were still live. */
export async function revokeFamily(db: Db, familyId: string, reason: string): Promise<number> {
  const now = new Date();
  await db.session.updateMany({ where: { familyId, invalidatedAt: null }, data: { invalidatedAt: now } });
  await db.phoneOnboardingGrant.deleteMany({ where: { familyId } });
  const res = await db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
  return res.count;
}

/** Revokes all refresh families of a user (optionally keeping one), e.g. after a password/email/phone change. Sessions are ended by the caller. */
export async function revokeUserRefreshFamilies(db: Db, userId: string, reason: string, keepFamilyId?: string | null): Promise<number> {
  const now = new Date();
  const where: Prisma.RefreshTokenWhereInput = { userId, revokedAt: null, ...(keepFamilyId ? { familyId: { not: keepFamilyId } } : {}) };
  const fams = await db.refreshToken.findMany({ where, select: { familyId: true }, distinct: ['familyId'] });
  if (fams.length) await db.session.updateMany({ where: { familyId: { in: fams.map((f) => f.familyId) }, invalidatedAt: null }, data: { invalidatedAt: now } });
  return (await db.refreshToken.updateMany({ where, data: { revokedAt: now, revokedReason: reason } })).count;
}

/** Ends every OTHER session and refresh family of the user (a sign-in method changed); the current session and its family stay. Returns sessions ended. */
export async function endOtherSessions(db: Db, userId: string, sessionId: string, reason: string): Promise<number> {
  const current = await db.session.findUnique({ where: { id: sessionId }, select: { familyId: true } });
  const ended = (await db.session.updateMany({ where: { userId, invalidatedAt: null, id: { not: sessionId } }, data: { invalidatedAt: new Date() } })).count;
  await revokeUserRefreshFamilies(db, userId, reason, current?.familyId ?? null);
  return ended;
}

/** Ends the previous live mobile families of the same installation so repeated sign-ins do not pile up. */
export async function revokeDeviceFamilies(db: Db, userId: string, deviceId: string): Promise<void> {
  const fams = await db.refreshToken.findMany({ where: { userId, deviceId, revokedAt: null }, select: { familyId: true }, distinct: ['familyId'] });
  for (const f of fams) await revokeFamily(db, f.familyId, 'superseded');
}

/** Same for the restricted (onboarding) families of one Firebase user on one installation. */
export async function revokeOnboardingFamilies(db: Db, subjectUid: string, deviceId?: string): Promise<void> {
  const fams = await db.refreshToken.findMany({ where: { kind: 'onboarding', subjectUid, revokedAt: null, ...(deviceId ? { deviceId } : {}) }, select: { familyId: true }, distinct: ['familyId'] });
  for (const f of fams) await revokeFamily(db, f.familyId, 'superseded');
}

export interface RefreshInput {
  refreshToken: string;
  deviceId: string;
}

export type RefreshOutcome =
  | { kind: 'user'; userId: string; credentials: MobileCredentials }
  | { kind: 'onboarding'; subject: Subject; credentials: MobileCredentials };

/** Rotates a refresh token. Throws AppError (401 REFRESH_TOKEN_INVALID | REFRESH_TOKEN_EXPIRED, 409 REFRESH_CONFLICT, 403 ACCOUNT_BLOCKED | FORBIDDEN, 429). */
export async function rotateRefreshToken(ctx: AppContext, input: RefreshInput, ipKey: string): Promise<RefreshOutcome> {
  const { prisma, config } = ctx;
  const now = new Date();
  const hash = tokenHash(input.refreshToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
  if (!row) {
    ctx.loginThrottle.recordFailure(ipKey);
    throw REFRESH_INVALID();
  }
  const famKey = `refresh|fam|${row.familyId}`;
  // Per-family budget: a legitimate client refreshes about once per access-token lifetime.
  if (ctx.loginThrottle.isBlocked(famKey, now.getTime(), 60)) throw new AppError(429, 'RATE_LIMITED', 'Too many refresh attempts. Try again later.');
  ctx.loginThrottle.recordFailure(famKey, now.getTime());

  const audience = row.userId ?? null;
  const reuse = async (reason: string) => {
    // Audit only when something live was actually revoked: a token from an already-revoked family is expected noise (logout, earlier reuse).
    const live = await revokeFamily(prisma, row.familyId, reason);
    if (live > 0) await audit(prisma, { shopId: null, actorUserId: audience, action: 'auth.refresh.reuse_detected', targetType: audience ? 'user' : 'phone', ...(audience ? { targetId: audience } : {}), metadata: { reason, kind: row.kind } });
    ctx.loginThrottle.recordFailure(ipKey);
    return REFRESH_INVALID();
  };

  if (row.deviceId !== input.deviceId) throw await reuse('device_mismatch');
  if (row.revokedAt) {
    // A restricted token spent by a successful onboarding is simply done; touching its family would also drop the short retry grant.
    if (row.revokedReason === 'onboarded') throw REFRESH_INVALID();
    throw await reuse('revoked_token_presented');
  }
  if (row.rotatedAt) {
    if (now.getTime() - row.rotatedAt.getTime() <= config.REFRESH_REUSE_GRACE_SECONDS * 1000) throw REFRESH_CONFLICT();
    throw await reuse('rotated_token_presented');
  }
  if (row.expiresAt <= now) {
    ctx.loginThrottle.recordFailure(ipKey);
    throw REFRESH_EXPIRED();
  }

  const claim = async () => {
    // Atomic: exactly one concurrent request flips rotatedAt; the other gets 409 and must retry serially.
    const claimed = await prisma.refreshToken.updateMany({ where: { id: row.id, rotatedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { rotatedAt: now, lastUsedAt: now } });
    if (claimed.count !== 1) throw REFRESH_CONFLICT();
  };

  // Restricted (onboarding) family: still restricted unless the identity was linked to an account in the meantime.
  if (row.kind === 'onboarding') {
    const provider = row.subjectProvider === 'google' ? 'google' : 'phone';
    if (!row.subjectUid || (provider === 'phone' ? !row.subjectPhone : !row.subjectEmail)) throw await reuse('malformed_onboarding_token');
    const linkedUserId =
      provider === 'phone'
        ? (await prisma.userPhoneIdentity.findFirst({ where: { firebaseUid: row.subjectUid }, select: { userId: true, phoneE164: true } }).then((i) => (i && i.phoneE164 !== row.subjectPhone ? 'mismatch' : (i?.userId ?? null))))
        : (await prisma.userGoogleIdentity.findFirst({ where: { firebaseUid: row.subjectUid }, select: { userId: true } }))?.userId ?? null;
    if (linkedUserId === 'mismatch') throw await reuse('identity_mismatch');
    if (!linkedUserId) {
      await claim();
      const subject: Subject = { provider, uid: row.subjectUid, phone: row.subjectPhone, email: row.subjectEmail, authTime: now };
      const credentials = await issueRestrictedCredentials(ctx, subject, row.deviceId, row.familyId);
      ctx.loginThrottle.reset(ipKey);
      await audit(prisma, { shopId: null, actorUserId: null, actorType: 'SYSTEM', action: 'auth.refresh', targetType: 'phone', metadata: { kind: 'onboarding', provider } });
      return { kind: 'onboarding', subject, credentials };
    }
    const owner = await prisma.user.findUnique({ where: { id: linkedUserId }, select: { id: true, role: true, isActive: true, shop: { select: { status: true } } } });
    if (!owner || (owner.role !== 'SHOP_OWNER' && owner.role !== 'CUSTOMER') || !owner.isActive || owner.shop?.status === 'SUSPENDED') {
      await revokeFamily(prisma, row.familyId, 'account_blocked');
      throw owner?.shop?.status === 'SUSPENDED' || (owner && !owner.isActive) ? accountBlocked() : new AppError(403, 'FORBIDDEN', 'This account cannot be renewed.');
    }
    await claim();
    await revokeFamily(prisma, row.familyId, 'upgraded'); // the restricted family ends; a normal user family starts
    await revokeDeviceFamilies(prisma, owner.id, row.deviceId);
    const credentials = await issueMobileCredentials(ctx, owner.id, row.deviceId);
    ctx.loginThrottle.reset(ipKey);
    await audit(prisma, { shopId: null, actorUserId: owner.id, actorType: owner.role === 'CUSTOMER' ? 'CUSTOMER' : 'SHOP_OWNER', action: 'auth.refresh', targetType: 'user', targetId: owner.id, metadata: { kind: 'onboarding_upgraded' } });
    return { kind: 'user', userId: owner.id, credentials };
  }

  // Account checks on every refresh: a removed, demoted or suspended account loses the whole family.
  const user = await prisma.user.findUnique({ where: { id: row.userId! }, select: { id: true, role: true, isActive: true, shop: { select: { status: true } } } });
  if (!user || (user.role !== 'SHOP_OWNER' && user.role !== 'CUSTOMER') || !user.isActive || user.shop?.status === 'SUSPENDED') {
    await revokeFamily(prisma, row.familyId, 'account_blocked');
    throw user?.shop?.status === 'SUSPENDED' || (user && !user.isActive) ? accountBlocked() : new AppError(403, 'FORBIDDEN', 'This account cannot be renewed.');
  }

  await claim();
  if (row.sessionId) await prisma.session.updateMany({ where: { id: row.sessionId, invalidatedAt: null }, data: { invalidatedAt: now } });
  const credentials = await issueMobileCredentials(ctx, user.id, row.deviceId, row.familyId);
  ctx.loginThrottle.reset(ipKey);
  await audit(prisma, { shopId: null, actorUserId: user.id, actorType: user.role === 'CUSTOMER' ? 'CUSTOMER' : 'SHOP_OWNER', action: 'auth.refresh', targetType: 'user', targetId: user.id });
  return { kind: 'user', userId: user.id, credentials };
}

/** Housekeeping for the retention worker: expired/old refresh rows and expired onboarding grants. */
export async function sweepCredentials(prisma: PrismaClient, now = new Date()): Promise<{ refreshTokens: number; grants: number }> {
  const cutoff = new Date(now.getTime() - 7 * 86_400_000);
  const refreshTokens = (await prisma.refreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }, { rotatedAt: { lt: cutoff } }] } })).count;
  const grants = (await prisma.phoneOnboardingGrant.deleteMany({ where: { expiresAt: { lt: now } } })).count;
  return { refreshTokens, grants };
}
