import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mobileAuthResponse, webAuthResponse } from '../domain/auth-response.js';
import { accountBlocked, issueRestrictedCredentials, revokeOnboardingFamilies } from '../domain/credentials.js';
import { clearGrantCookie, issueGrant, setGrantCookie } from '../domain/onboarding-grant.js';
import { restrictedProfile } from '../domain/profile.js';
import { AppError } from '../errors.js';
import { PhoneTokenInvalidError, PhoneVerifierUnavailableError, maskEmail, type VerifiedGoogle } from '../firebase/verifier.js';
import { clientIpKey } from '../rate-limits.js';
import { authResponseFor, type FirebaseSignInResult } from './auth-firebase.js';
import { assertSameOrigin } from './auth-phone.js';
import { sessionPayload } from './auth.js';
import { actorTypeOf, audit, json, openSession, type AppContext } from './context.js';
import { roleForAudience, type Audience } from './auth-firebase.js';

export const GOOGLE_UNAVAILABLE_ERROR = () => new AppError(503, 'GOOGLE_LOGIN_UNAVAILABLE', 'Google sign-in is unavailable right now. Use another sign-in method.');
export const GOOGLE_TOKEN_INVALID_ERROR = () => new AppError(401, 'GOOGLE_TOKEN_INVALID', 'That Google sign-in could not be confirmed. Try again.');

const sessionBody = z.object({ idToken: z.string().min(20).max(4096) }).strict();

/** Web Google sign-in: exchange of a verified Firebase Google ID token for the normal session cookie or restricted onboarding grant. */
export async function authGoogleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;

  app.post(
    '/auth/google/session',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (request, reply) => {
      assertSameOrigin(ctx, request);
      const body = sessionBody.parse(request.body);
      const { verified, ipKey } = await verifyGoogleToken(ctx, request, body.idToken);
      const masked = maskEmail(verified.email);

      const identity = await prisma.userGoogleIdentity.findUnique({ where: { firebaseUid: verified.uid }, include: { user: { include: { shop: true } } } });
      if (!identity) {
        ctx.loginThrottle.reset(ipKey);
        await audit(prisma, {
          shopId: null,
          actorUserId: null,
          actorType: 'SYSTEM',
          action: 'auth.google.login',
          targetType: 'google',
          metadata: { method: 'google', client: 'web', outcome: 'onboarding', email: masked }
        });
        const grant = await issueGrant(ctx, {
          provider: 'google',
          firebaseUid: verified.uid,
          email: verified.email,
          authTime: verified.authTime
        });
        setGrantCookie(ctx, reply, grant.raw, grant.expiresAt);
        return json(
          webAuthResponse(
            ctx,
            restrictedProfile({ provider: 'google', email: verified.email }),
            { onboarding: { expiresAt: grant.expiresAt } }
          )
        );
      }

      const user = identity.user;
      if (user.role !== 'SHOP_OWNER' || !user.shopId) {
        throw new AppError(403, 'FORBIDDEN', 'Google sign-in is not available for this account.');
      }
      if (user.shop?.status === 'SUSPENDED') throw new AppError(403, 'SHOP_SUSPENDED', 'This shop is suspended');

      const claimed = await prisma.userGoogleIdentity.updateMany({
        where: { id: identity.id, OR: [{ lastAuthTime: null }, { lastAuthTime: { lt: verified.authTime } }] },
        data: { lastAuthTime: verified.authTime, lastSignInAt: new Date(), email: verified.email }
      });
      if (claimed.count !== 1) {
        await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'auth.google.login_refused', targetType: 'user', targetId: user.id, metadata: { reason: 'replay', email: masked } });
        throw GOOGLE_TOKEN_INVALID_ERROR();
      }

      ctx.loginThrottle.reset(ipKey);
      clearGrantCookie(ctx, reply);
      const csrf = await openSession(ctx, request, reply, user.id);
      await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'auth.google.login', targetType: 'user', targetId: user.id, metadata: { email: masked } });
      return json({
        ...sessionPayload(user, csrf, config.PRINT_RETENTION_MINUTES),
        nextStep: 'complete',
        onboarding: null
      });
    }
  );
}

/**
 * Web Google sign-in for MARKETPLACE CUSTOMERS (separate route so the owner web flow above is untouched). Same rules: resolution only by
 * the Firebase uid (an email or phone that merely matches an owner never links or signs in), replay protection on auth_time, strict
 * Origin check, cookie + CSRF session. An unlinked identity gets the restricted onboarding cookie (nextStep create_customer) and
 * finishes with POST /customers/onboarding (client web). Only CUSTOMER accounts are accepted here; owners and admins get 403.
 */
export async function authCustomerGoogleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  app.post('/auth/customer/google/session', { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    assertSameOrigin(ctx, request);
    const body = sessionBody.parse(request.body);
    const { verified, ipKey } = await verifyGoogleToken(ctx, request, body.idToken);
    const masked = maskEmail(verified.email);
    const identity = await prisma.userGoogleIdentity.findUnique({ where: { firebaseUid: verified.uid }, include: { user: true } });
    if (!identity) {
      ctx.loginThrottle.reset(ipKey);
      await audit(prisma, { shopId: null, actorUserId: null, actorType: 'SYSTEM', action: 'auth.google.login', targetType: 'google', metadata: { method: 'google', client: 'web', audience: 'customer', outcome: 'onboarding', email: masked } });
      const grant = await issueGrant(ctx, { provider: 'google', firebaseUid: verified.uid, email: verified.email, authTime: verified.authTime });
      setGrantCookie(ctx, reply, grant.raw, grant.expiresAt);
      return json(webAuthResponse(ctx, restrictedProfile({ provider: 'google', email: verified.email }, 'customer'), { onboarding: { expiresAt: grant.expiresAt } }));
    }
    const user = identity.user;
    if (user.role !== 'CUSTOMER') throw new AppError(403, 'FORBIDDEN', 'Google sign-in is not available for this account.');
    if (!user.isActive) throw new AppError(403, 'ACCOUNT_BLOCKED', 'This account is blocked. Contact Printout Buddy support.', { nextStep: 'account_blocked' });
    const claimed = await prisma.userGoogleIdentity.updateMany({
      where: { id: identity.id, OR: [{ lastAuthTime: null }, { lastAuthTime: { lt: verified.authTime } }] },
      data: { lastAuthTime: verified.authTime, lastSignInAt: new Date(), email: verified.email }
    });
    if (claimed.count !== 1) {
      await audit(prisma, { shopId: null, actorUserId: user.id, actorType: 'CUSTOMER', action: 'auth.google.login_refused', targetType: 'user', targetId: user.id, metadata: { reason: 'replay', email: masked } });
      throw GOOGLE_TOKEN_INVALID_ERROR();
    }
    ctx.loginThrottle.reset(ipKey);
    clearGrantCookie(ctx, reply);
    const out = await authResponseFor(ctx, request, reply, user.id, 'web', undefined);
    await audit(prisma, { shopId: null, actorUserId: user.id, actorType: 'CUSTOMER', action: 'auth.google.login', targetType: 'user', targetId: user.id, metadata: { client: 'web', audience: 'customer', email: masked } });
    return json(out);
  });
}

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
  input: { idToken: string; deviceId: string; auditAction: 'auth.login' | 'auth.firebase.exchange'; audience?: Audience | undefined }
): Promise<FirebaseSignInResult> {
  const { prisma } = ctx;
  const audience: Audience = input.audience ?? 'shop';
  const { verified, ipKey } = await verifyGoogleToken(ctx, request, input.idToken);
  const masked = maskEmail(verified.email);

  const identity = await prisma.userGoogleIdentity.findUnique({ where: { firebaseUid: verified.uid }, include: { user: { include: { shop: true } } } });
  if (!identity) {
    ctx.loginThrottle.reset(ipKey);
    await audit(prisma, { shopId: null, actorUserId: null, actorType: 'SYSTEM', action: input.auditAction, targetType: 'google', metadata: { method: 'google', client: 'mobile', outcome: 'onboarding', email: masked } });
    await revokeOnboardingFamilies(prisma, verified.uid, input.deviceId);
    const creds = await issueRestrictedCredentials(ctx, { provider: 'google', uid: verified.uid, email: verified.email, authTime: verified.authTime }, input.deviceId);
    return { response: mobileAuthResponse(ctx, restrictedProfile({ provider: 'google', email: verified.email }, audience), creds), principal: null };
  }

  const user = identity.user;
  // Admins are never signed in through Google (no Admin 2FA bypass, no admin auto-creation); only the role of the requesting app is accepted.
  if (user.role !== roleForAudience(audience)) throw new AppError(403, 'FORBIDDEN', 'Google sign-in is not available for this account.');
  if (user.shop?.status === 'SUSPENDED' || !user.isActive) throw accountBlocked();
  // Replay protection: each Google sign-in has a strictly later auth_time; a token can be exchanged once.
  const claimed = await prisma.userGoogleIdentity.updateMany({
    where: { id: identity.id, OR: [{ lastAuthTime: null }, { lastAuthTime: { lt: verified.authTime } }] },
    data: { lastAuthTime: verified.authTime, lastSignInAt: new Date(), email: verified.email }
  });
  if (claimed.count !== 1) {
    await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: actorTypeOf(user.role), action: 'auth.google.login_refused', targetType: 'user', targetId: user.id, metadata: { reason: 'replay', email: masked } });
    throw GOOGLE_TOKEN_INVALID_ERROR();
  }
  ctx.loginThrottle.reset(ipKey);
  const response = await authResponseFor(ctx, request, reply, user.id, 'mobile', input.deviceId);
  await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: actorTypeOf(user.role), action: input.auditAction, targetType: 'user', targetId: user.id, metadata: { method: 'google', client: 'mobile', outcome: 'session', email: masked } });
  return { response, principal: { userId: user.id, shopId: user.shopId } };
}
