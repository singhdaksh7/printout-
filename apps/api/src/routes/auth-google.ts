import type { FastifyReply, FastifyRequest } from 'fastify';
import { mobileAuthResponse } from '../domain/auth-response.js';
import { accountBlocked, issueRestrictedCredentials, revokeOnboardingFamilies } from '../domain/credentials.js';
import { restrictedProfile } from '../domain/profile.js';
import { AppError } from '../errors.js';
import { PhoneTokenInvalidError, PhoneVerifierUnavailableError, maskEmail, type VerifiedGoogle } from '../firebase/verifier.js';
import { clientIpKey } from '../rate-limits.js';
import { authResponseFor, type FirebaseSignInResult } from './auth-firebase.js';
import { audit, type AppContext } from './context.js';

export const GOOGLE_UNAVAILABLE_ERROR = () => new AppError(503, 'GOOGLE_LOGIN_UNAVAILABLE', 'Google sign-in is unavailable right now. Use another sign-in method.');
export const GOOGLE_TOKEN_INVALID_ERROR = () => new AppError(401, 'GOOGLE_TOKEN_INVALID', 'That Google sign-in could not be confirmed. Try again.');

/** Verifies a Firebase Google ID token (project, freshness, revocation per config, provider google.com, Google-VERIFIED email). */
export async function verifyGoogleToken(ctx: AppContext, request: FastifyRequest, idToken: string): Promise<{ verified: VerifiedGoogle; ipKey: string }> {
  const verifier = ctx.phoneVerifier;
  if (!ctx.config.GOOGLE_LOGIN_ENABLED || !verifier?.verifyGoogle) throw GOOGLE_UNAVAILABLE_ERROR();
  const ipKey = `google|${clientIpKey(request.ip)}`;
  if (ctx.loginThrottle.isBlocked(ipKey)) throw new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.');
  try {
    return { verified: await verifier.verifyGoogle(idToken), ipKey };
  } catch (error) {
    if (error instanceof PhoneVerifierUnavailableError) throw GOOGLE_UNAVAILABLE_ERROR();
    ctx.loginThrottle.recordFailure(ipKey);
    if (error instanceof PhoneTokenInvalidError) throw GOOGLE_TOKEN_INVALID_ERROR();
    throw GOOGLE_UNAVAILABLE_ERROR();
  }
}

/**
 * Continue with Google (mobile, bearer pair). Resolution is ONLY by the trusted Firebase uid -> UserGoogleIdentity -> user. An email (even a
 * Google-verified one) that merely equals an existing user's email NEVER links or signs in anything: that user must sign in with their
 * existing method and link Google explicitly. An unlinked Google identity gets the restricted onboarding pair (nextStep create_shop).
 */
export async function googleSignIn(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { idToken: string; deviceId: string; auditAction: 'auth.login' | 'auth.firebase.exchange' }
): Promise<FirebaseSignInResult> {
  const { prisma } = ctx;
  const { verified, ipKey } = await verifyGoogleToken(ctx, request, input.idToken);
  const masked = maskEmail(verified.email);

  const identity = await prisma.userGoogleIdentity.findUnique({ where: { firebaseUid: verified.uid }, include: { user: { include: { shop: true } } } });
  if (!identity) {
    ctx.loginThrottle.reset(ipKey);
    await audit(prisma, { shopId: null, actorUserId: null, actorType: 'SYSTEM', action: input.auditAction, targetType: 'google', metadata: { method: 'google', client: 'mobile', outcome: 'onboarding', email: masked } });
    await revokeOnboardingFamilies(prisma, verified.uid, input.deviceId);
    const creds = await issueRestrictedCredentials(ctx, { provider: 'google', uid: verified.uid, email: verified.email, authTime: verified.authTime }, input.deviceId);
    return { response: mobileAuthResponse(ctx, restrictedProfile({ provider: 'google', email: verified.email }), creds), principal: null };
  }

  const user = identity.user;
  // Admins are never signed in through Google (no Admin 2FA bypass, no admin auto-creation); neither is any non-owner.
  if (user.role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'Google sign-in is not available for this account.');
  if (user.shop?.status === 'SUSPENDED') throw accountBlocked();
  // Replay protection: each Google sign-in has a strictly later auth_time; a token can be exchanged once.
  const claimed = await prisma.userGoogleIdentity.updateMany({
    where: { id: identity.id, OR: [{ lastAuthTime: null }, { lastAuthTime: { lt: verified.authTime } }] },
    data: { lastAuthTime: verified.authTime, lastSignInAt: new Date(), email: verified.email }
  });
  if (claimed.count !== 1) {
    await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'auth.google.login_refused', targetType: 'user', targetId: user.id, metadata: { reason: 'replay', email: masked } });
    throw GOOGLE_TOKEN_INVALID_ERROR();
  }
  ctx.loginThrottle.reset(ipKey);
  const response = await authResponseFor(ctx, request, reply, user.id, 'mobile', input.deviceId);
  await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: input.auditAction, targetType: 'user', targetId: user.id, metadata: { method: 'google', client: 'mobile', outcome: 'session', email: masked } });
  return { response, principal: { userId: user.id, shopId: user.shopId } };
}
