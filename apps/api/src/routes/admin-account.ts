import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth.js';
import { AppError } from '../errors.js';
import { reauthenticateAdmin } from './admin-reauth.js';
import { passwordPolicyProblem } from '../password-policy.js';
import { getLimiters } from '../rate-limits.js';
import { adminGuard, audit, authOf, clearSessionCookie, isUniqueViolation, json, type AppContext } from './context.js';

/**
 * Platform-admin self-service credentials. Every route acts ONLY on the authenticated admin (the id comes from the
 * session, never from the request). Changing the email or the password requires the CURRENT password, runs as one
 * transaction (credential update + all of the admin's sessions ended + audit row) and signs the admin out everywhere,
 * exactly like the `admin:update` CLI. Passwords, hashes and tokens are never returned, logged or audited.
 */
const currentPassword = z.string().min(1).max(256);

const emailBody = z
  .object({
    currentPassword,
    newEmail: z.string().trim().max(254).email().transform((v) => v.toLowerCase())
  })
  .strict();

const passwordBody = z.object({ currentPassword, newPassword: z.string().min(1).max(256) }).strict();

const EMAIL_UNAVAILABLE = () => new AppError(409, 'EMAIL_UNAVAILABLE', 'This email address cannot be used. Choose a different one.');

export async function adminAccountRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_ADMIN_READ_MAX * 5));
  app.addHook('preHandler', adminGuard(ctx));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const reauthenticate = (request: FastifyRequest, password: string, operation: 'email' | 'password') => reauthenticateAdmin(ctx, request, password, operation);

  /** Credential update + session invalidation + audit as one unit; a concurrent change to the same user loses cleanly. */
  async function commit(
    reply: FastifyReply,
    user: { id: string; email: string; passwordHash: string },
    data: { email?: string; passwordHash?: string },
    action: 'admin.account.email_changed' | 'admin.account.password_changed'
  ): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: user.id, role: 'PLATFORM_ADMIN', email: user.email, passwordHash: user.passwordHash },
          data
        });
        if (updated.count !== 1) throw new AppError(409, 'CONFLICT', 'Your account changed while this request was running. Reload and try again.');
        const ended = await tx.session.updateMany({ where: { userId: user.id, invalidatedAt: null }, data: { invalidatedAt: new Date() } });
        // A pending second-factor sign-in was issued for the OLD credentials: destroy it. 2FA itself stays enabled.
        await tx.adminLoginChallenge.deleteMany({ where: { userId: user.id } });
        await audit(tx, {
          shopId: null,
          actorUserId: user.id,
          actorType: 'PLATFORM_ADMIN',
          action,
          targetType: 'user',
          targetId: user.id,
          metadata: { sessionsEnded: ended.count }
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw EMAIL_UNAVAILABLE();
      throw error;
    }
    clearSessionCookie(ctx, reply);
  }

  app.get('/admin/account', { preHandler: limits.adminRead }, async (request) => {
    const auth = authOf(request);
    const now = new Date();
    const [user, session, otherActiveSessions] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, email: true, displayName: true, role: true, createdAt: true } }),
      prisma.session.findUniqueOrThrow({ where: { id: auth.sessionId }, select: { createdAt: true, expiresAt: true } }),
      prisma.session.count({ where: { userId: auth.userId, invalidatedAt: null, expiresAt: { gt: now }, id: { not: auth.sessionId } } })
    ]);
    return json({ ...user, session: { startedAt: session.createdAt, expiresAt: session.expiresAt, otherActiveSessions } });
  });

  app.post('/admin/account/email', { preHandler: limits.adminMutation }, async (request, reply) => {
    const body = emailBody.parse(request.body);
    const user = await reauthenticate(request, body.currentPassword, 'email');
    if (body.newEmail === user.email) throw new AppError(400, 'VALIDATION_ERROR', 'The new email is the same as the current email.', { field: 'newEmail' });
    if (await prisma.user.findUnique({ where: { email: body.newEmail }, select: { id: true } })) throw EMAIL_UNAVAILABLE();
    await commit(reply, user, { email: body.newEmail }, 'admin.account.email_changed');
    return json({ email: body.newEmail, signedOut: true });
  });

  app.post('/admin/account/password', { preHandler: limits.adminMutation }, async (request, reply) => {
    const body = passwordBody.parse(request.body);
    const user = await reauthenticate(request, body.currentPassword, 'password');
    const problem = passwordPolicyProblem(body.newPassword, user.email, 'New password');
    if (problem) throw new AppError(400, 'VALIDATION_ERROR', problem, { field: 'newPassword' });
    if (body.newPassword === body.currentPassword) {
      throw new AppError(400, 'VALIDATION_ERROR', 'The new password must be different from the current password.', { field: 'newPassword' });
    }
    await commit(reply, user, { passwordHash: await hashPassword(body.newPassword) }, 'admin.account.password_changed');
    return json({ signedOut: true });
  });
}
