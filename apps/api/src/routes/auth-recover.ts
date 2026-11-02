import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { burnPasswordCheck, verifyPassword } from '../auth.js';
import { revokeUserRefreshFamilies } from '../domain/credentials.js';
import { clearGrantCookie } from '../domain/onboarding-grant.js';
import { AppError } from '../errors.js';
import { maskEmail } from '../firebase/verifier.js';
import { clientIpKey } from '../rate-limits.js';
import { GOOGLE_UNAVAILABLE_ERROR, verifyGoogleToken } from './auth-google.js';
import { assertSameOrigin } from './auth-phone.js';
import { sessionPayload } from './auth.js';
import { audit, isUniqueViolation, json, openSession, type AppContext } from './context.js';

const recoverBody = z
  .object({
    email: z.string().trim().max(254).email().transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(256),
    idToken: z.string().min(20).max(4096)
  })
  .strict();

const INVALID = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
const UNAVAILABLE = () => new AppError(409, 'GOOGLE_IDENTITY_UNAVAILABLE', 'This Google account cannot be used. Try a different one.');
const ALREADY_LINKED = () => new AppError(409, 'GOOGLE_ALREADY_LINKED', 'This account already has a Google account linked. Sign in with Google instead.');

/**
 * One-time legacy owner recovery: a shop owner who only ever had email + password proves BOTH the existing account (that password) and a
 * Google identity (a verified Firebase Google ID token in the same request); the Google uid is then linked and a normal cookie session
 * is issued. Never links by email or phone alone. Admins, customers and shop-less users are refused with the generic credentials error.
 * Failures share the /auth/login throttles (per IP+email and per account) so guesses cannot be spread across endpoints.
 */
export async function authRecoverRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;

  app.post('/auth/google/recover', { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    assertSameOrigin(ctx, request);
    const body = recoverBody.parse(request.body);
    if (!config.GOOGLE_LOGIN_ENABLED || !ctx.phoneVerifier?.verifyGoogle) throw GOOGLE_UNAVAILABLE_ERROR();

    const throttleKey = `recover|${clientIpKey(request.ip)}|${body.email}`;
    const accountKey = `acct|${body.email}`;
    if (ctx.loginThrottle.isBlocked(throttleKey) || ctx.loginThrottle.isBlocked(accountKey, Date.now(), config.LOGIN_FAIL_MAX * 4)) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.');
    }

    // 1) The existing account is proven by its password (unknown accounts still pay one verification: no timing oracle).
    const user = await prisma.user.findUnique({ where: { email: body.email }, include: { shop: true, googleIdentity: true } });
    const valid = user ? await verifyPassword(user.passwordHash, body.password) : await burnPasswordCheck(body.password);
    const eligible = !!user && user.role === 'SHOP_OWNER' && !!user.shopId && user.isActive && user.passwordSet;
    if (!user || !valid || !eligible) {
      ctx.loginThrottle.recordFailure(throttleKey);
      ctx.loginThrottle.recordFailure(accountKey);
      if (user && valid) {
        await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SYSTEM', action: 'auth.google.recover_refused', targetType: 'user', targetId: user.id, metadata: { reason: 'ineligible_account' } });
      } else if (user) {
        await audit(prisma, { shopId: user.shopId, actorUserId: null, actorType: 'SYSTEM', action: 'auth.google.recover_failed', targetType: 'user', targetId: user.id, metadata: { reason: 'invalid_credentials' } });
      }
      throw INVALID();
    }
    if (user.shop?.status === 'SUSPENDED') throw new AppError(403, 'SHOP_SUSPENDED', 'This shop is suspended');

    // 2) The Google identity is proven by a verified, fresh Firebase Google ID token (project, provider google.com, verified email).
    const { verified } = await verifyGoogleToken(ctx, request, body.idToken);
    const masked = maskEmail(verified.email);
    const refuse = async (reason: string) => {
      await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SYSTEM', action: 'auth.google.recover_refused', targetType: 'user', targetId: user.id, metadata: { reason, email: masked } });
    };

    try {
      const ended = await prisma.$transaction(async (tx) => {
        const own = await tx.userGoogleIdentity.findUnique({ where: { userId: user.id }, select: { id: true } });
        if (own) throw ALREADY_LINKED();
        const clash = await tx.userGoogleIdentity.findUnique({ where: { firebaseUid: verified.uid }, select: { id: true } });
        if (clash) throw UNAVAILABLE();
        await tx.userGoogleIdentity.create({
          data: { userId: user.id, firebaseUid: verified.uid, email: verified.email, linkedAt: new Date(), lastSignInAt: new Date(), lastAuthTime: verified.authTime }
        });
        // A sign-in method changed: every existing session and refresh family of the account ends (the new session is opened afterwards).
        const sessions = (await tx.session.updateMany({ where: { userId: user.id, invalidatedAt: null }, data: { invalidatedAt: new Date() } })).count;
        await revokeUserRefreshFamilies(tx, user.id, 'google_changed');
        await audit(tx, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'auth.google.recovered', targetType: 'user', targetId: user.id, metadata: { email: masked, otherSessionsEnded: sessions } });
        return sessions;
      });
      void ended;
    } catch (error) {
      if (error instanceof AppError) {
        await refuse(error.code === 'GOOGLE_ALREADY_LINKED' ? 'account_already_linked' : 'google_uid_in_use');
        throw error;
      }
      if (isUniqueViolation(error)) {
        await refuse('google_uid_in_use');
        throw UNAVAILABLE();
      }
      throw error;
    }

    ctx.loginThrottle.reset(throttleKey);
    ctx.loginThrottle.reset(accountKey);
    clearGrantCookie(ctx, reply);
    const csrf = await openSession(ctx, request, reply, user.id);
    return json({ ...sessionPayload(user, csrf, config.PRINT_RETENTION_MINUTES), nextStep: 'complete', onboarding: null, recovered: true });
  });
}
