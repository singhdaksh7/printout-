import type { FastifyRequest } from 'fastify';
import { verifyPassword } from '../auth.js';
import { AppError } from '../errors.js';
import { PhoneTokenInvalidError, PhoneVerifierUnavailableError } from '../firebase/verifier.js';
import { PHONE_UNAVAILABLE_ERROR } from './auth-phone.js';
import { audit, authOf, type AppContext } from './context.js';

export type ShopReauthOperation = 'phone_link' | 'phone_unlink' | 'email_change' | 'google_link' | 'google_unlink';

/**
 * Re-authenticates the signed-in shop owner with their current password before a sign-in-method change. Failures share the
 * per-account budget used by the admin account routes (`acctchg|<userId>`), so guesses cannot be spread across endpoints.
 */
export async function reauthenticateShopOwner(ctx: AppContext, request: FastifyRequest, password: string, operation: ShopReauthOperation) {
  const { prisma } = ctx;
  const auth = authOf(request);
  const key = `acctchg|${auth.userId}`;
  if (ctx.loginThrottle.isBlocked(key)) throw new AppError(429, 'RATE_LIMITED', 'Too many incorrect password attempts. Try again later.');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
  if (user.role !== 'SHOP_OWNER' || !user.shopId || !(await verifyPassword(user.passwordHash, password))) {
    ctx.loginThrottle.recordFailure(key);
    await audit(prisma, {
      shopId: user.shopId,
      actorUserId: user.id,
      actorType: 'SHOP_OWNER',
      action: 'shop.phone.reauth_failed',
      targetType: 'user',
      targetId: user.id,
      metadata: { operation }
    });
    throw new AppError(403, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect.');
  }
  ctx.loginThrottle.reset(key);
  return user;
}

/** Proof that the caller owns the signed-in account: the current password, OR a fresh Firebase token of an identity ALREADY linked to it. */
export interface ReauthProof {
  currentPassword?: string | undefined;
  firebaseIdToken?: string | undefined;
}

/**
 * Generalized re-authentication for sign-in-method changes. The password path is exactly reauthenticateShopOwner. The token path lets an
 * account that has no usable password (self-onboarded through Google or phone) prove itself with a FRESH token (auth_time within
 * FIREBASE_AUTH_MAX_AGE_SECONDS) of an identity that is already linked to this very account; the token's uid must match that identity,
 * and it is single use (auth_time must be later than the identity's last accepted one). Failures share the `acctchg|<userId>` budget.
 */
export async function reauthenticateOwner(ctx: AppContext, request: FastifyRequest, proof: ReauthProof, operation: ShopReauthOperation) {
  const hasPassword = proof.currentPassword !== undefined;
  const hasToken = proof.firebaseIdToken !== undefined;
  if (hasPassword === hasToken) throw new AppError(400, 'VALIDATION_ERROR', 'Provide exactly one of currentPassword or a fresh sign-in token to confirm it is you.');
  if (hasPassword) return reauthenticateShopOwner(ctx, request, proof.currentPassword!, operation);

  const { prisma } = ctx;
  const auth = authOf(request);
  const key = `acctchg|${auth.userId}`;
  if (ctx.loginThrottle.isBlocked(key)) throw new AppError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.');
  const verifier = ctx.phoneVerifier;
  if (!verifier?.verifyAny) throw PHONE_UNAVAILABLE_ERROR();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { phoneIdentity: true, googleIdentity: true } });
  const fail = async () => {
    ctx.loginThrottle.recordFailure(key);
    await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'shop.reauth_failed', targetType: 'user', targetId: user.id, metadata: { operation, method: 'token' } });
    return new AppError(403, 'REAUTH_FAILED', 'We could not confirm it is you. Sign in again and retry.');
  };
  if (user.role !== 'SHOP_OWNER' || !user.shopId) throw await fail();
  let proven;
  try {
    proven = await verifier.verifyAny(proof.firebaseIdToken!);
  } catch (error) {
    if (error instanceof PhoneVerifierUnavailableError) throw PHONE_UNAVAILABLE_ERROR();
    if (error instanceof PhoneTokenInvalidError) throw await fail();
    throw PHONE_UNAVAILABLE_ERROR();
  }
  // The token must belong to an identity already linked to THIS account (never merely to someone who knows the email or the number).
  let claimed = 0;
  if (proven.provider === 'phone' && user.phoneIdentity && user.phoneIdentity.firebaseUid === proven.uid && user.phoneIdentity.phoneE164 === proven.phoneE164) {
    claimed = (await prisma.userPhoneIdentity.updateMany({ where: { id: user.phoneIdentity.id, OR: [{ lastAuthTime: null }, { lastAuthTime: { lt: proven.authTime } }] }, data: { lastAuthTime: proven.authTime } })).count;
  } else if (proven.provider === 'google' && user.googleIdentity && user.googleIdentity.firebaseUid === proven.uid) {
    claimed = (await prisma.userGoogleIdentity.updateMany({ where: { id: user.googleIdentity.id, OR: [{ lastAuthTime: null }, { lastAuthTime: { lt: proven.authTime } }] }, data: { lastAuthTime: proven.authTime } })).count;
  }
  if (claimed !== 1) throw await fail();
  ctx.loginThrottle.reset(key);
  return user;
}
