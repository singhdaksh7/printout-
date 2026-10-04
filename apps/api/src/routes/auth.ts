import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { burnPasswordCheck, csrfToken, newToken, tokenHash, verifyPassword } from '../auth.js';
import { AppError } from '../errors.js';
import {
  assertCsrf,
  audit,
  authenticate,
  authOf,
  clearSessionCookie,
  json,
  SESSION_COOKIE,
  setSessionCookie,
  type AppContext
} from './context.js';

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

interface UserWithShop {
  id: string;
  displayName: string;
  role: string;
  shop: { id: string; slug: string; displayName: string } | null;
}

const sessionPayload = (user: UserWithShop, csrf: string) => ({
  user: { id: user.id, displayName: user.displayName, role: user.role },
  shop: user.shop ? { id: user.shop.id, slug: user.shop.slug, displayName: user.shop.displayName } : null,
  csrfToken: csrf
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;

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

      // Rotation: any session presented with this request is ended; a fresh random token is always issued.
      const previous = request.cookies[SESSION_COOKIE];
      if (previous) {
        await prisma.session.updateMany({
          where: { tokenHash: tokenHash(previous), invalidatedAt: null },
          data: { invalidatedAt: new Date() }
        });
      }
      const raw = newToken();
      const expiresAt = new Date(Date.now() + config.SESSION_DAYS * 86_400_000);
      const session = await prisma.session.create({ data: { userId: user.id, tokenHash: tokenHash(raw), expiresAt } });
      setSessionCookie(ctx, reply, raw, expiresAt);
      await audit(prisma, { shopId: user.shopId, actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id });
      return json(sessionPayload(user, csrfToken(config.CSRF_SECRET, session.id)));
    }
  );

  app.post('/auth/logout', async (request, reply) => {
    const auth = await authenticate(ctx, request);
    assertCsrf(ctx, request, auth);
    await prisma.session.updateMany({ where: { id: auth.sessionId }, data: { invalidatedAt: new Date() } });
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });

  app.get('/auth/session', async (request) => {
    await authenticate(ctx, request);
    const auth = authOf(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { shop: true } });
    return json(sessionPayload(user, csrfToken(config.CSRF_SECRET, auth.sessionId)));
  });
}
