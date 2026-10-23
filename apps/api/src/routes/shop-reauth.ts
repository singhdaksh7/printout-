import type { FastifyRequest } from 'fastify';
import { verifyPassword } from '../auth.js';
import { AppError } from '../errors.js';
import { audit, authOf, type AppContext } from './context.js';

export type ShopReauthOperation = 'phone_link' | 'phone_unlink';

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
