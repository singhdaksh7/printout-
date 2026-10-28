import type { FastifyRequest } from 'fastify';
import { verifyPassword } from '../auth.js';
import { AppError } from '../errors.js';
import { audit, authOf, staffEmail, type AppContext } from './context.js';

export type ReauthOperation = 'email' | 'password' | '2fa_enroll' | '2fa_disable' | '2fa_regenerate';

/** Re-authenticates the signed-in admin with their current password. Failures are throttled per admin account. */
export async function reauthenticateAdmin(ctx: AppContext, request: FastifyRequest, password: string, operation: ReauthOperation) {
  const { prisma } = ctx;
  const auth = authOf(request);
  const key = `acctchg|${auth.userId}`;
  if (ctx.loginThrottle.isBlocked(key)) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many incorrect password attempts. Try again later.');
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
  if (!(await verifyPassword(user.passwordHash, password))) {
    ctx.loginThrottle.recordFailure(key);
    await audit(prisma, {
      shopId: null,
      actorUserId: user.id,
      actorType: 'PLATFORM_ADMIN',
      action: 'admin.account.reauth_failed',
      targetType: 'user',
      targetId: user.id,
      metadata: { operation }
    });
    throw new AppError(403, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect.');
  }
  ctx.loginThrottle.reset(key);
  return { ...user, email: staffEmail(user) };
}
