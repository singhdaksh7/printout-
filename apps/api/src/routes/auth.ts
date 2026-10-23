import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { burnPasswordCheck, csrfToken, newToken, tokenHash, verifyPassword } from '../auth.js';
import { revokeFamily } from '../domain/credentials.js';
import { resolveGrant } from '../domain/onboarding-grant.js';
import { revokeInstallation } from '../notifications/fcm-registrations.js';
import { AppError } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import {
  assertCsrf,
  audit,
  authenticate,
  authOf,
  CHALLENGE_COOKIE,
  clearChallengeCookie,
  clearSessionCookie,
  json,
  openSession as openSessionFor,
  setChallengeCookie,
  type AppContext
} from './context.js';
import {
  assertSecondFactorNotThrottled,
  consumeSecondFactor,
  credentialFingerprint,
  requireKeys,
  secondFactorKey
} from '../two-factor/service.js';

const loginBody = z
  .object({
    email: z
      .string()
      .trim()
      .max(254)
      .email()
      .transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(256)
  })
  .strict();

export interface UserWithShop {
  id: string;
  displayName: string;
  role: string;
  shop: { id: string; slug: string; displayName: string } | null;
}

export const sessionPayload = (user: UserWithShop, csrf: string, retentionMinutes: number) => ({
  user: { id: user.id, displayName: user.displayName, role: user.role },
  shop: user.shop ? { id: user.shop.id, slug: user.shop.slug, displayName: user.shop.displayName } : null,
  csrfToken: csrf,
  /** Server-authoritative post-print retention window; the UI displays it and never hard-codes it. */
  retentionMinutes
});

const secondFactorBody = z
  .object({ method: z.enum(['totp', 'recovery']), code: z.string().trim().min(1).max(64) })
  .strict();

const CHALLENGE_INVALID = () =>
  new AppError(401, 'TWO_FACTOR_CHALLENGE_INVALID', 'Your sign-in expired or was already used. Enter your password again.');

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);

  const openSession = (request: FastifyRequest, reply: FastifyReply, userId: string) => openSessionFor(ctx, request, reply, userId);

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = loginBody.parse(request.body);
      const throttleKey = `${request.ip}|${body.email}`;
      // Account-wide failure budget, independent of the client IP, so rotating (or spoofing) IPs cannot buy unlimited guesses.
      const accountKey = `acct|${body.email}`;
      if (ctx.loginThrottle.isBlocked(throttleKey) || ctx.loginThrottle.isBlocked(accountKey, Date.now(), config.LOGIN_FAIL_MAX * 4)) {
        throw new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.');
      }

      const user = await prisma.user.findUnique({ where: { email: body.email }, include: { shop: true } });
      // Unknown accounts still pay for one password verification so timing does not reveal existence.
      const valid = user ? await verifyPassword(user.passwordHash, body.password) : await burnPasswordCheck(body.password);
      if (!user || !valid) {
        ctx.loginThrottle.recordFailure(throttleKey);
        ctx.loginThrottle.recordFailure(accountKey);
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }
      if (user.shop?.status === 'SUSPENDED') throw new AppError(403, 'SHOP_SUSPENDED', 'This shop is suspended');
      ctx.loginThrottle.reset(throttleKey);
      ctx.loginThrottle.reset(accountKey);

      // Platform admins with ENABLED two-factor get a restricted pending challenge instead of a session.
      if (user.role === 'PLATFORM_ADMIN') {
        const factor = await prisma.adminTwoFactor.findUnique({ where: { userId: user.id }, select: { enabledAt: true } });
        if (factor?.enabledAt) {
          // Fail closed: without the key nobody can verify a code, and a missing key must never mean "skip the check".
          requireKeys(ctx);
          // One pending challenge per browser: a new password entry replaces the one this browser still holds.
          const stale = request.cookies[CHALLENGE_COOKIE];
          const now = new Date();
          if (stale) await prisma.adminLoginChallenge.updateMany({ where: { tokenHash: tokenHash(stale), consumedAt: null }, data: { consumedAt: now } });
          await prisma.adminLoginChallenge.deleteMany({
            where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null }, createdAt: { lt: new Date(now.getTime() - 3_600_000) } }] }
          });
          const rawChallenge = newToken();
          const expiresAt = new Date(now.getTime() + config.TWO_FACTOR_CHALLENGE_TTL_SECONDS * 1000);
          await prisma.adminLoginChallenge.create({
            data: { tokenHash: tokenHash(rawChallenge), userId: user.id, credentialFp: credentialFingerprint(ctx, user.passwordHash), expiresAt, createdAt: now }
          });
          setChallengeCookie(ctx, reply, rawChallenge, expiresAt);
          await audit(prisma, { shopId: null, actorUserId: user.id, actorType: 'PLATFORM_ADMIN', action: 'auth.2fa.challenge_issued', targetType: 'user', targetId: user.id });
          return json({ twoFactorRequired: true as const, expiresInSeconds: config.TWO_FACTOR_CHALLENGE_TTL_SECONDS });
        }
      }

      const csrf = await openSession(request, reply, user.id);
      await audit(prisma, { shopId: user.shopId, actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id });
      return json(sessionPayload(user, csrf, config.PRINT_RETENTION_MINUTES));
    }
  );

  /**
   * Second step of an admin sign-in. Needs the pending-challenge cookie from /auth/login (no session exists yet).
   * Each attempt is reserved BEFORE the code is checked (parallel guesses cannot exceed the per-challenge budget), the
   * code is consumed atomically (no replay), and the challenge is single-use. Only then is a full session issued.
   */
  app.post(
    '/auth/login/2fa',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = secondFactorBody.parse(request.body);
      const raw = request.cookies[CHALLENGE_COOKIE];
      if (!raw || raw.length > 200) throw CHALLENGE_INVALID();
      const challenge = await prisma.adminLoginChallenge.findUnique({ where: { tokenHash: tokenHash(raw) }, include: { user: true } });
      if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date() || challenge.attempts >= config.TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS) {
        clearChallengeCookie(ctx, reply);
        throw CHALLENGE_INVALID();
      }
      const user = challenge.user;
      if (user.role !== 'PLATFORM_ADMIN' || challenge.credentialFp !== credentialFingerprint(ctx, user.passwordHash)) {
        await prisma.adminLoginChallenge.deleteMany({ where: { id: challenge.id } });
        clearChallengeCookie(ctx, reply);
        throw CHALLENGE_INVALID();
      }
      assertSecondFactorNotThrottled(ctx, user.id);

      // Reserve the attempt atomically; zero rows means another request used up the budget or consumed the challenge.
      const reserved = await prisma.adminLoginChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, attempts: { lt: config.TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } }
      });
      if (reserved.count !== 1) throw CHALLENGE_INVALID();

      const outcome = await consumeSecondFactor(ctx, user.id, { method: body.method, code: body.code });
      if (!outcome.ok) {
        ctx.loginThrottle.recordFailure(secondFactorKey(user.id));
        await audit(prisma, {
          shopId: null,
          actorUserId: user.id,
          actorType: 'PLATFORM_ADMIN',
          action: 'auth.2fa.failed',
          targetType: 'user',
          targetId: user.id,
          metadata: { method: outcome.method, reason: outcome.reason }
        });
        // An exhausted challenge stays in place (attempts >= max already makes it unusable). Deleting it here could race a
        // concurrent request on the same challenge that is about to succeed; expired rows are swept at the next sign-in.
        if (challenge.attempts + 1 >= config.TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS) clearChallengeCookie(ctx, reply);
        throw new AppError(401, 'INVALID_TWO_FACTOR_CODE', 'That code is not valid.');
      }

      // Single-use: whichever request flips consumedAt wins; a concurrent twin gets the same error as a stale challenge.
      const consumed = await prisma.adminLoginChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (consumed.count !== 1) throw CHALLENGE_INVALID();
      ctx.loginThrottle.reset(secondFactorKey(user.id));
      clearChallengeCookie(ctx, reply);

      const csrf = await openSession(request, reply, user.id);
      const base = { shopId: null, actorUserId: user.id, actorType: 'PLATFORM_ADMIN' as const, targetType: 'user', targetId: user.id };
      await audit(prisma, { ...base, action: 'auth.login', metadata: { secondFactor: outcome.method } });
      if (outcome.method === 'recovery') {
        await audit(prisma, { ...base, action: 'auth.2fa.recovery_code_used', metadata: { remaining: outcome.recoveryCodesRemaining ?? 0 } });
      }
      return json({
        ...sessionPayload({ ...user, shop: null }, csrf, config.PRINT_RETENTION_MINUTES),
        ...(outcome.method === 'recovery' ? { recoveryCodesRemaining: outcome.recoveryCodesRemaining ?? 0 } : {})
      });
    }
  );

  /** Abandons the pending challenge held by this browser (the "Back" button on the code screen). */
  app.post('/auth/login/2fa/cancel', async (request, reply) => {
    const raw = request.cookies[CHALLENGE_COOKIE];
    if (raw) await prisma.adminLoginChallenge.updateMany({ where: { tokenHash: tokenHash(raw), consumedAt: null }, data: { consumedAt: new Date() } });
    clearChallengeCookie(ctx, reply);
    return reply.code(204).send();
  });

  /**
   * Ends THIS session, and for a mobile session its whole refresh family and the device's push registration. Cookie callers need the CSRF
   * header; bearer callers do not. A mobile app whose access token already expired can still sign out by sending its refresh token in
   * the body (idempotent: an unknown or already-revoked token answers 204 as well).
   */
  app.post('/auth/logout', { preHandler: limits.shopMutation }, async (request, reply) => {
    const optional = z.object({ refreshToken: z.string().min(20).max(200).optional() }).strict().parse(request.body ?? {});
    let auth;
    try {
      auth = await authenticate(ctx, request);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'UNAUTHORIZED') throw error;
      // A restricted onboarding principal (access token = grant) signs out by ending its grant and refresh family.
      const grant = await resolveGrant(ctx, request);
      if (grant) {
        await prisma.phoneOnboardingGrant.deleteMany({ where: { id: grant.id } });
        if (grant.familyId) await revokeFamily(prisma, grant.familyId, 'logout');
        return reply.code(204).send();
      }
      if (!optional.refreshToken) throw error;
      const row = await prisma.refreshToken.findUnique({ where: { tokenHash: tokenHash(optional.refreshToken) } });
      if (row) {
        await revokeFamily(prisma, row.familyId, 'logout');
        await audit(prisma, { shopId: null, actorUserId: row.userId, action: 'auth.logout', targetType: row.userId ? 'user' : 'phone', ...(row.userId ? { targetId: row.userId } : {}), metadata: { transport: 'refresh' } });
      }
      return reply.code(204).send();
    }
    assertCsrf(ctx, request, auth);
    const session = await prisma.session.findUnique({ where: { id: auth.sessionId }, select: { familyId: true, deviceId: true } });
    await prisma.session.updateMany({ where: { id: auth.sessionId }, data: { invalidatedAt: new Date() } });
    if (session?.familyId) await revokeFamily(prisma, session.familyId, 'logout');
    if (optional.refreshToken) {
      const row = await prisma.refreshToken.findUnique({ where: { tokenHash: tokenHash(optional.refreshToken) } });
      if (row && row.userId === auth.userId) await revokeFamily(prisma, row.familyId, 'logout');
    }
    if (session?.deviceId) await revokeInstallation(prisma, auth.userId, session.deviceId);
    await audit(prisma, { shopId: auth.shopId, actorUserId: auth.userId, action: 'auth.logout', targetType: 'user', targetId: auth.userId, metadata: { transport: auth.viaBearer ? 'bearer' : 'cookie' } });
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });

  app.get('/auth/session', { preHandler: limits.shopRead }, async (request) => {
    await authenticate(ctx, request);
    const auth = authOf(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { shop: true } });
    return json(sessionPayload(user, csrfToken(config.CSRF_SECRET, auth.sessionId), config.PRINT_RETENTION_MINUTES));
  });
}
