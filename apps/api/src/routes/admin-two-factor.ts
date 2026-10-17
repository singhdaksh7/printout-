import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { sealSecret } from '../two-factor/crypto.js';
import {
  assertSecondFactorNotThrottled,
  consumeSecondFactor,
  ENROLLMENT_TTL_MS,
  openUserSecret,
  prepareRecoveryCodes,
  requireKeys,
  secondFactorKey,
  storeRecoveryCodes,
  TWO_FACTOR_ISSUER
} from '../two-factor/service.js';
import { formatManualKey, generateTotpSecret, matchTotp, otpauthUri } from '../two-factor/totp.js';
import { reauthenticateAdmin } from './admin-reauth.js';
import { adminGuard, audit, authOf, json, type AppContext } from './context.js';

/**
 * Platform-admin two-factor management. Every route acts ONLY on the authenticated admin (id from the session), is
 * behind the admin guard (session + role + CSRF on every mutation) and answers `Cache-Control: no-store`.
 * Secrets, codes and recovery codes are returned only in the response that creates them and are never logged or audited.
 *
 * Session policy: enabling or disabling 2FA ends the admin's OTHER sessions (they were established under the old
 * assurance level) and keeps the current one. Changing the password or email (admin-account.ts) ends every session and
 * destroys pending sign-in challenges but keeps 2FA enabled.
 */
const password = z.string().min(1).max(256);
const code = z.string().trim().min(1).max(64);

const enrollBody = z.object({ currentPassword: password }).strict();
const verifyBody = z.object({ code }).strict();
const regenerateBody = z.object({ currentPassword: password, code }).strict();
const disableBody = z.object({ currentPassword: password, method: z.enum(['totp', 'recovery']).default('totp'), code }).strict();

const INVALID_CODE = () => new AppError(403, 'INVALID_TWO_FACTOR_CODE', 'That code is not valid. Check your authenticator app and try again.');

export async function adminTwoFactorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_ADMIN_READ_MAX * 5));
  app.addHook('preHandler', adminGuard(ctx));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const actor = (userId: string) => ({ shopId: null, actorUserId: userId, actorType: 'PLATFORM_ADMIN' as const, targetType: 'user', targetId: userId });

  /** Ends every other session of the admin (the calling session continues). */
  const endOtherSessions = (tx: Pick<typeof prisma, 'session'>, userId: string, keepSessionId: string) =>
    tx.session.updateMany({ where: { userId, invalidatedAt: null, id: { not: keepSessionId } }, data: { invalidatedAt: new Date() } });

  /** Wrong second-factor answer on a management route: throttle + audit, then a uniform error. */
  async function rejectCode(userId: string, operation: string, method: string, reason: string): Promise<never> {
    ctx.loginThrottle.recordFailure(secondFactorKey(userId));
    await audit(prisma, { ...actor(userId), action: 'admin.2fa.code_rejected', metadata: { operation, method, reason } });
    throw INVALID_CODE();
  }

  app.get('/admin/account/2fa', { preHandler: limits.adminRead }, async (request) => {
    const auth = authOf(request);
    const row = await prisma.adminTwoFactor.findUnique({ where: { userId: auth.userId }, select: { enabledAt: true, recoveryAckAt: true, createdAt: true } });
    const enabled = !!row?.enabledAt;
    const remaining = enabled ? await prisma.adminRecoveryCode.count({ where: { userId: auth.userId, usedAt: null } }) : 0;
    return json({
      available: !!ctx.twoFactorKeys,
      enabled,
      enrolledAt: row?.enabledAt ?? null,
      recoveryCodesRemaining: remaining,
      recoveryCodesAcknowledged: enabled ? !!row?.recoveryAckAt : false,
      enrollmentPending: !!row && !enabled && Date.now() - row.createdAt.getTime() < ENROLLMENT_TTL_MS
    });
  });

  /** Step 1: re-authenticate, then create (or replace) a PENDING secret. Nothing is enabled until step 2 succeeds. */
  app.post('/admin/account/2fa/enroll', { preHandler: limits.adminMutation }, async (request) => {
    const body = enrollBody.parse(request.body);
    const keys = requireKeys(ctx);
    const user = await reauthenticateAdmin(ctx, request, body.currentPassword, '2fa_enroll');
    const existing = await prisma.adminTwoFactor.findUnique({ where: { userId: user.id }, select: { enabledAt: true } });
    if (existing?.enabledAt) throw new AppError(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');

    const secret = generateTotpSecret();
    const { sealed, keyId } = sealSecret(keys, user.id, secret);
    await prisma.$transaction([
      prisma.adminTwoFactor.deleteMany({ where: { userId: user.id, enabledAt: null } }),
      prisma.adminTwoFactor.create({ data: { userId: user.id, secretEnc: sealed, keyId, createdAt: new Date() } }),
      audit(prisma, { ...actor(user.id), action: 'admin.2fa.enroll_started' })
    ]);
    return json({
      issuer: TWO_FACTOR_ISSUER,
      accountName: user.email,
      otpauthUri: otpauthUri({ secret, accountName: user.email, issuer: TWO_FACTOR_ISSUER }),
      manualKey: formatManualKey(secret),
      expiresInSeconds: ENROLLMENT_TTL_MS / 1000
    });
  });

  /** Step 2: a valid code from the app proves it holds the secret. Only now is 2FA enabled and recovery codes issued. */
  app.post('/admin/account/2fa/enroll/verify', { preHandler: limits.adminMutation }, async (request) => {
    const body = verifyBody.parse(request.body);
    const auth = authOf(request);
    assertSecondFactorNotThrottled(ctx, auth.userId);
    const row = await prisma.adminTwoFactor.findUnique({ where: { userId: auth.userId } });
    if (!row || row.enabledAt) throw new AppError(409, 'NO_PENDING_ENROLLMENT', 'Start two-factor setup first.');
    if (Date.now() - row.createdAt.getTime() > ENROLLMENT_TTL_MS) {
      await prisma.adminTwoFactor.deleteMany({ where: { userId: auth.userId, enabledAt: null } });
      throw new AppError(409, 'NO_PENDING_ENROLLMENT', 'This setup expired. Start two-factor setup again.');
    }
    const step = matchTotp(openUserSecret(ctx, auth.userId, row.secretEnc), body.code, Date.now());
    if (step === null) return rejectCode(auth.userId, 'enroll', 'totp', 'invalid');

    const { plain, hashes } = await prepareRecoveryCodes();
    const enabledAt = new Date();
    await prisma.$transaction(async (tx) => {
      const enabled = await tx.adminTwoFactor.updateMany({
        where: { userId: auth.userId, enabledAt: null },
        data: { enabledAt, lastUsedStep: BigInt(step), recoveryAckAt: null }
      });
      if (enabled.count !== 1) throw new AppError(409, 'NO_PENDING_ENROLLMENT', 'Start two-factor setup first.');
      await storeRecoveryCodes(tx, auth.userId, hashes);
      const ended = await endOtherSessions(tx, auth.userId, auth.sessionId);
      await audit(tx, { ...actor(auth.userId), action: 'admin.2fa.enabled', metadata: { otherSessionsEnded: ended.count } });
    });
    ctx.loginThrottle.reset(secondFactorKey(auth.userId));
    return json({ enabledAt, recoveryCodes: plain });
  });

  /** The admin confirms the recovery codes are stored safely (UI gate); recorded so status can nag if they never do. */
  app.post('/admin/account/2fa/recovery-codes/acknowledge', { preHandler: limits.adminMutation }, async (request, reply) => {
    const auth = authOf(request);
    const updated = await prisma.adminTwoFactor.updateMany({ where: { userId: auth.userId, enabledAt: { not: null } }, data: { recoveryAckAt: new Date() } });
    if (updated.count !== 1) throw new AppError(409, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled.');
    return reply.code(204).send();
  });

  /** New batch; every previous code stops working. Needs the password AND a current authenticator code (not a recovery code). */
  app.post('/admin/account/2fa/recovery-codes', { preHandler: limits.adminMutation }, async (request) => {
    const body = regenerateBody.parse(request.body);
    const auth = authOf(request);
    assertSecondFactorNotThrottled(ctx, auth.userId);
    const user = await reauthenticateAdmin(ctx, request, body.currentPassword, '2fa_regenerate');
    const outcome = await consumeSecondFactor(ctx, user.id, { method: 'totp', code: body.code });
    if (!outcome.ok) return rejectCode(user.id, 'regenerate', 'totp', outcome.reason);

    const { plain, hashes } = await prepareRecoveryCodes();
    await prisma.$transaction(async (tx) => {
      await storeRecoveryCodes(tx, user.id, hashes);
      await tx.adminTwoFactor.update({ where: { userId: user.id }, data: { recoveryAckAt: null } });
      await audit(tx, { ...actor(user.id), action: 'admin.2fa.recovery_codes_regenerated' });
    });
    ctx.loginThrottle.reset(secondFactorKey(user.id));
    return json({ recoveryCodes: plain });
  });

  /** Turns 2FA off. Needs the password AND an authenticator or recovery code. */
  app.post('/admin/account/2fa/disable', { preHandler: limits.adminMutation }, async (request) => {
    const body = disableBody.parse(request.body);
    const auth = authOf(request);
    assertSecondFactorNotThrottled(ctx, auth.userId);
    const user = await reauthenticateAdmin(ctx, request, body.currentPassword, '2fa_disable');
    const outcome = await consumeSecondFactor(ctx, user.id, { method: body.method, code: body.code });
    if (!outcome.ok) return rejectCode(user.id, 'disable', body.method, outcome.reason);

    await prisma.$transaction(async (tx) => {
      const removed = await tx.adminTwoFactor.deleteMany({ where: { userId: user.id, enabledAt: { not: null } } });
      if (removed.count !== 1) throw new AppError(409, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled.');
      await tx.adminRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.adminLoginChallenge.deleteMany({ where: { userId: user.id } });
      const ended = await endOtherSessions(tx, user.id, auth.sessionId);
      await audit(tx, { ...actor(user.id), action: 'admin.2fa.disabled', metadata: { method: body.method, otherSessionsEnded: ended.count } });
    });
    ctx.loginThrottle.reset(secondFactorKey(user.id));
    return json({ enabled: false });
  });
}
