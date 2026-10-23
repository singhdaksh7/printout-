import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mobileAuthResponse } from '../domain/auth-response.js';
import { REFRESH_INVALID, revokeUserRefreshFamilies, rotateRefreshToken } from '../domain/credentials.js';
import { loadProfile, restrictedProfile } from '../domain/profile.js';
import { AppError } from '../errors.js';
import { revokeAllForUser } from '../notifications/fcm-registrations.js';
import { clientIpKey, getLimiters } from '../rate-limits.js';
import { deviceIdSchema } from './auth-firebase.js';
import { assertCsrf, audit, authenticate, authOf, clearSessionCookie, json, type AppContext } from './context.js';

/** The token is validated by hand, not by zod: every malformed/forged/over- or under-length value must answer the SAME 401 as an unknown token (no oracle). */
const refreshBody = z.object({ refreshToken: z.unknown().optional(), deviceId: deviceIdSchema }).strict();
const MIN_TOKEN = 20;
const MAX_TOKEN = 512;
const logoutAllBody = z.object({ keepPush: z.boolean().default(false) }).strict();

/**
 * Mobile session renewal and global sign-out.
 *  POST /auth/refresh  unauthenticated, body only (a refresh token never travels in a URL, header or cookie). Atomic single-use rotation,
 *                      reuse detection (a replayed rotated token revokes the whole family) and a re-check of the account on every call.
 *  POST /auth/logout-all  ends every session and refresh family of the caller (all devices); push registrations are removed unless keepPush.
 */
export async function authRefreshRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post(
    '/auth/refresh',
    {
      // A refresh body is ~150 bytes. Anything declared larger gets the SAME 401 as a forged token, before the body is read or parsed
      // (no size oracle, no work on huge input); bodyLimit is the backstop for undeclared (chunked) bodies.
      bodyLimit: 4096,
      onRequest: async (request) => {
        const declared = Number(request.headers['content-length'] ?? 0);
        if (Number.isFinite(declared) && declared > 4096) {
          ctx.loginThrottle.recordFailure(`refresh|${clientIpKey(request.ip)}`);
          throw REFRESH_INVALID();
        }
      },
      config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX * 3, timeWindow: '1 minute' } }
    },
    async (request) => {
      const ipKey = `refresh|${clientIpKey(request.ip)}`;
      // Failures (unknown/forged/expired/reused) count per client IP; a legitimate app fails rarely.
      if (ctx.loginThrottle.isBlocked(ipKey, Date.now(), config.LOGIN_FAIL_MAX * 4)) throw new AppError(429, 'RATE_LIMITED', 'Too many refresh attempts. Try again later.');
      const body = refreshBody.parse(request.body);
      const presented = body.refreshToken;
      // Cheap rejection (never hash huge input), identical shape and status to an unknown/forged token; counts against the IP budget.
      if (typeof presented !== 'string' || presented.length < MIN_TOKEN || presented.length > MAX_TOKEN) {
        ctx.loginThrottle.recordFailure(ipKey);
        throw REFRESH_INVALID();
      }
      const outcome = await rotateRefreshToken(ctx, { refreshToken: presented, deviceId: body.deviceId }, ipKey);
      // Same body as sign-in: a restricted identity that has meanwhile been linked to an account gets the normal profile and pair here.
      const view =
        outcome.kind === 'user'
          ? await loadProfile(prisma, config.WEB_ORIGIN, outcome.userId)
          : restrictedProfile({ provider: outcome.subject.provider, phone: outcome.subject.phone ?? null, email: outcome.subject.email ?? null });
      return json(mobileAuthResponse(ctx, view, outcome.credentials));
    }
  );

  const sessionGuard = async (request: FastifyRequest): Promise<void> => {
    const auth = await authenticate(ctx, request);
    assertCsrf(ctx, request, auth);
  };

  app.post('/auth/logout-all', { preHandler: [sessionGuard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const body = logoutAllBody.parse(request.body ?? {});
    await prisma.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { userId: auth.userId, invalidatedAt: null }, data: { invalidatedAt: new Date() } });
      await revokeUserRefreshFamilies(tx, auth.userId, 'logout_all');
      const pushRevoked = body.keepPush ? 0 : await revokeAllForUser(tx, auth.userId);
      await audit(tx, { shopId: auth.shopId, actorUserId: auth.userId, actorType: auth.role === 'PLATFORM_ADMIN' ? 'PLATFORM_ADMIN' : 'SHOP_OWNER', action: 'auth.logout_all', targetType: 'user', targetId: auth.userId, metadata: { keepPush: body.keepPush, pushRevoked } });
    });
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });
}
