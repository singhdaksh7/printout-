import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tokenHash } from '../auth.js';
import { mobileAuthResponse, webAuthResponse } from '../domain/auth-response.js';
import { accountBlocked, issueMobileCredentials, issueRestrictedCredentials, revokeDeviceFamilies, revokeOnboardingFamilies, type MobileCredentials } from '../domain/credentials.js';
import { issueGrant, setGrantCookie } from '../domain/onboarding-grant.js';
import { loadProfile, restrictedProfile, type MobileAuthResponse, type WebAuthResponse } from '../domain/profile.js';
import { AppError } from '../errors.js';
import { PhoneTokenInvalidError, PhoneVerifierUnavailableError, maskPhone, type VerifiedPhone } from '../firebase/verifier.js';
import { clientIpKey } from '../rate-limits.js';
import { assertSameOrigin, PHONE_TOKEN_INVALID_ERROR, PHONE_UNAVAILABLE_ERROR } from './auth-phone.js';
import { audit, bearerOf, json, openCookieSession, type AppContext } from './context.js';

export const clientParam = z.enum(['web', 'mobile']).default('web');
/** Installation id chosen by the app (random, stable per install); binds refresh tokens and the device's push registration. */
export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'deviceId must be 16-64 characters: letters, digits, _ or -');
export const requireDeviceForMobile = (b: { client: 'web' | 'mobile'; deviceId?: string | undefined }, c: z.RefinementCtx) => {
  if (b.client === 'mobile' && !b.deviceId) c.addIssue({ code: 'custom', path: ['deviceId'], message: 'deviceId is required for mobile clients' });
};
const exchangeBody = z
  .object({ idToken: z.string().min(20).max(4096), client: clientParam, deviceId: deviceIdSchema.optional() })
  .strict()
  .superRefine(requireDeviceForMobile);

/** Verified-token handling shared by the phone routes: per-IP failure budget, safe error mapping, 503 on outage. */
export async function verifyFirebaseToken(ctx: AppContext, request: FastifyRequest, idToken: string): Promise<{ verified: VerifiedPhone; ipKey: string }> {
  const verifier = ctx.phoneVerifier;
  if (!verifier) throw PHONE_UNAVAILABLE_ERROR();
  const ipKey = `phone|${clientIpKey(request.ip)}`;
  if (ctx.loginThrottle.isBlocked(ipKey)) throw new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.');
  try {
    return { verified: await verifier.verify(idToken), ipKey };
  } catch (error) {
    if (error instanceof PhoneVerifierUnavailableError) throw PHONE_UNAVAILABLE_ERROR();
    ctx.loginThrottle.recordFailure(ipKey);
    if (error instanceof PhoneTokenInvalidError) throw PHONE_TOKEN_INVALID_ERROR();
    throw PHONE_UNAVAILABLE_ERROR();
  }
}

/** Opens the mobile (bearer) credential pair for `userId`: ends a bearer session presented with the request and earlier families of this installation. */
export async function openMobileFor(ctx: AppContext, request: FastifyRequest, userId: string, deviceId: string): Promise<MobileCredentials> {
  const previous = bearerOf(request);
  if (previous) await ctx.prisma.session.updateMany({ where: { tokenHash: tokenHash(previous), invalidatedAt: null }, data: { invalidatedAt: new Date() } });
  await revokeDeviceFamilies(ctx.prisma, userId, deviceId);
  return issueMobileCredentials(ctx, userId, deviceId);
}

/** Opens a full session for `userId` in the transport the client asked for and returns the finished auth response. */
export async function authResponseFor(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  client: 'web' | 'mobile',
  deviceId: string | undefined
): Promise<MobileAuthResponse | WebAuthResponse> {
  if (client === 'mobile') {
    if (!deviceId) throw new AppError(400, 'VALIDATION_ERROR', 'deviceId is required for mobile clients', { field: 'deviceId' });
    const creds = await openMobileFor(ctx, request, userId, deviceId);
    return mobileAuthResponse(ctx, await loadProfile(ctx.prisma, ctx.config.WEB_ORIGIN, userId), creds);
  }
  const { csrf, expiresAt } = await openCookieSession(ctx, request, reply, userId);
  return webAuthResponse(ctx, await loadProfile(ctx.prisma, ctx.config.WEB_ORIGIN, userId), { session: { expiresAt }, csrfToken: csrf });
}

export interface FirebaseSignInInput {
  idToken: string;
  client: 'web' | 'mobile';
  deviceId?: string | undefined;
  /** Optional claim from the client; it MUST equal the verified number (it never authorizes anything by itself). */
  phoneNumber?: string | undefined;
  /** Audit action: 'auth.firebase.exchange' (exchange route) or 'auth.login' (unified POST /auth). */
  auditAction: 'auth.firebase.exchange' | 'auth.login';
}

export interface FirebaseSignInResult {
  response: MobileAuthResponse | WebAuthResponse;
  /** The authenticated account, or null for a restricted onboarding identity. */
  principal: { userId: string; shopId: string | null } | null;
}

/**
 * The one implementation behind POST /auth/firebase/exchange and POST /auth {loginMethod:'otp'}. The phone number only proves possession:
 *  - linked shop owner (link made earlier from Settings with password re-authentication) -> a normal session / credential pair;
 *  - verified phone with NO linked account -> a restricted principal (nextStep create_shop), nothing else;
 *  - platform admins never sign in by phone (and Admin 2FA is untouched).
 * The client never supplies a role, shop id or "verified" flag; the token is verified server side for the configured project.
 */
export async function firebaseSignIn(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, input: FirebaseSignInInput): Promise<FirebaseSignInResult> {
  const { prisma, config } = ctx;
  const { verified, ipKey } = await verifyFirebaseToken(ctx, request, input.idToken);
  if (input.phoneNumber !== undefined && input.phoneNumber !== verified.phoneE164) {
    // A claimed number that differs from the verified one is a forged/mismatched request: same error and same failure budget as a bad token.
    ctx.loginThrottle.recordFailure(ipKey);
    throw PHONE_TOKEN_INVALID_ERROR();
  }
  const masked = maskPhone(verified.phoneE164);
  const mobile = input.client === 'mobile';

  const byPhone = await prisma.userPhoneIdentity.findUnique({ where: { phoneE164: verified.phoneE164 }, include: { user: { include: { shop: true } } } });
  const identity = byPhone ?? (await prisma.userPhoneIdentity.findUnique({ where: { firebaseUid: verified.uid }, include: { user: { include: { shop: true } } } }));

  if (!identity) {
    // Restricted state: proof of the number only. No user, shop, role or account session is created.
    ctx.loginThrottle.reset(ipKey);
    await audit(prisma, { shopId: null, actorUserId: null, actorType: 'SYSTEM', action: input.auditAction, targetType: 'phone', metadata: { method: 'otp', client: input.client, outcome: 'onboarding', phone: masked } });
    if (mobile) {
      if (!input.deviceId) throw new AppError(400, 'VALIDATION_ERROR', 'deviceId is required for mobile clients', { field: 'deviceId' });
      await revokeOnboardingFamilies(prisma, verified.uid, input.deviceId);
      const creds = await issueRestrictedCredentials(ctx, { provider: 'phone', uid: verified.uid, phone: verified.phoneE164, authTime: verified.authTime }, input.deviceId);
      return { response: mobileAuthResponse(ctx, restrictedProfile(verified.phoneE164), creds), principal: null };
    }
    const grant = await issueGrant(ctx, { provider: 'phone', firebaseUid: verified.uid, phoneE164: verified.phoneE164, authTime: verified.authTime });
    setGrantCookie(ctx, reply, grant.raw, grant.expiresAt);
    return { response: webAuthResponse(ctx, restrictedProfile(verified.phoneE164), { onboarding: { expiresAt: grant.expiresAt } }), principal: null };
  }

  const user = identity.user;
  const refuse = (reason: string) =>
    audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'auth.phone.login_refused', targetType: 'user', targetId: user.id, metadata: { reason, phone: maskPhone(identity.phoneE164) } });
  // Admins (or any non-owner) are never signed in by SMS alone.
  if (user.role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'Phone sign-in is not available for this account.');
  if (user.shop?.status === 'SUSPENDED') throw mobile ? accountBlocked() : new AppError(403, 'SHOP_SUSPENDED', 'This shop is suspended');
  const reverify = async (reason: string) => {
    await refuse(reason);
    return new AppError(403, 'PHONE_REVERIFY_REQUIRED', 'For your security, sign in with your email and password and confirm this phone number again in Settings.');
  };
  if (identity.firebaseUid !== verified.uid || identity.phoneE164 !== verified.phoneE164) throw await reverify('uid_changed');
  const lastUse = identity.lastSignInAt ?? identity.linkedAt;
  if (Date.now() - lastUse.getTime() > config.PHONE_IDENTITY_MAX_IDLE_DAYS * 86_400_000) throw await reverify('idle');

  // Replay protection: each OTP verification has a strictly later auth_time; a token can be exchanged once.
  const claimed = await prisma.userPhoneIdentity.updateMany({
    where: { id: identity.id, OR: [{ lastAuthTime: null }, { lastAuthTime: { lt: verified.authTime } }] },
    data: { lastAuthTime: verified.authTime, lastSignInAt: new Date() }
  });
  if (claimed.count !== 1) {
    await refuse('replay');
    throw PHONE_TOKEN_INVALID_ERROR();
  }
  ctx.loginThrottle.reset(ipKey);

  const response = await authResponseFor(ctx, request, reply, user.id, input.client, input.deviceId);
  await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: input.auditAction, targetType: 'user', targetId: user.id, metadata: { method: 'otp', client: input.client, outcome: 'session', phone: masked } });
  return { response, principal: { userId: user.id, shopId: user.shopId } };
}

/** POST /auth/firebase/exchange: web (cookie + CSRF) or mobile (flat bearer pair). Kept for the web app; mobile docs use POST /auth. */
export async function authFirebaseRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config } = ctx;

  app.post(
    '/auth/firebase/exchange',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = exchangeBody.parse(request.body);
      if (body.client === 'web') assertSameOrigin(ctx, request);
      reply.header('cache-control', 'no-store');
      const { response } = await firebaseSignIn(ctx, request, reply, { idToken: body.idToken, client: body.client, deviceId: body.deviceId, auditAction: 'auth.firebase.exchange' });
      return json(response);
    }
  );
}
