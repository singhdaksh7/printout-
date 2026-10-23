/**
 * Lost-device recovery: remove the two-factor enrollment of ONE existing platform admin so they can sign in with their
 * password and enroll again. This is an OPERATOR procedure; there is deliberately no email or self-service equivalent
 * (admin email delivery is not verified, so an emailed link would be a bypass of the second factor).
 *
 *   DATABASE_URL=...  CURRENT_EMAIL=admin@example.com  CONFIRM_EMAIL=admin@example.com \
 *   RESET_REASON="ticket OPS-123: phone lost, identity verified by video call" corepack pnpm admin:2fa-reset
 *
 * Controls:
 * - DATABASE_URL must be set explicitly (the script acts on whatever database it points at; check it first).
 * - CURRENT_EMAIL names the admin; CONFIRM_EMAIL must repeat it exactly (guards against a stale shell history line).
 * - RESET_REASON (>= 10 characters) is required and stored in the audit trail with the operating-system user and host.
 * - Refuses non-admin accounts and accounts without a 2FA enrollment. Never creates or changes a password or an account.
 * - DRY_RUN=1 reports what would happen and changes nothing.
 * - Effects (one transaction): 2FA row, recovery codes and pending sign-in challenges deleted, ALL sessions of the admin
 *   ended, one audit row `admin.2fa.cli_reset`. The encryption key is NOT needed and is never read.
 * - Prints no secret, code, token or hash. Exit: 0 ok, 1 runtime failure, 2 refused.
 *
 * Operators must verify the admin's identity out of band BEFORE running this; see docs/ADMIN_2FA.md.
 */
import { PrismaClient, Role } from '@prisma/client';
import os from 'node:os';
import { unwrapHash } from '../src/auth.js';

const MIN_REASON = 10;

async function main(): Promise<number> {
  const fail = (m: string, code: 1 | 2 = 2) => {
    console.error(`reset-admin-2fa: ${m}`);
    return code;
  };
  if (!process.env.DATABASE_URL?.trim()) return fail('DATABASE_URL must be set explicitly');
  const email = process.env.CURRENT_EMAIL?.trim().toLowerCase();
  if (!email) return fail('CURRENT_EMAIL is required (the admin whose 2FA is reset)');
  if (process.env.CONFIRM_EMAIL?.trim().toLowerCase() !== email) return fail('CONFIRM_EMAIL must repeat CURRENT_EMAIL exactly');
  const reason = process.env.RESET_REASON?.trim() ?? '';
  if (reason.length < MIN_REASON) return fail(`RESET_REASON is required (at least ${MIN_REASON} characters: ticket and how identity was verified)`);
  if (reason.length > 300) return fail('RESET_REASON is too long (max 300 characters)');
  const dryRun = ['1', 'true', 'yes'].includes((process.env.DRY_RUN ?? '').toLowerCase());

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return fail(`no user with email ${email}`);
    if (user.role !== Role.PLATFORM_ADMIN) return fail(`${email} is not a PLATFORM_ADMIN; refusing`);
    const factor = await prisma.adminTwoFactor.findUnique({ where: { userId: user.id }, select: { enabledAt: true } });
    if (!factor) return fail(`${email} has no two-factor enrollment; nothing to reset`);
    const activeSessions = await prisma.session.count({ where: { userId: user.id, invalidatedAt: null } });
    if (dryRun) {
      console.log(`DRY RUN: would remove ${factor.enabledAt ? 'the enabled' : 'a pending'} 2FA enrollment of ${email} and end ${activeSessions} active session(s). Nothing changed.`);
      return 0;
    }
    let operator = 'unknown';
    try {
      operator = os.userInfo().username;
    } catch {
      /* some containers have no passwd entry */
    }
    await prisma.$transaction([
      // Restore the plain password hash (the rollback-guard prefix is only valid while 2FA is on).
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: unwrapHash(user.passwordHash) } }),
      prisma.adminTwoFactor.deleteMany({ where: { userId: user.id } }),
      prisma.adminRecoveryCode.deleteMany({ where: { userId: user.id } }),
      prisma.adminLoginChallenge.deleteMany({ where: { userId: user.id } }),
      prisma.session.updateMany({ where: { userId: user.id, invalidatedAt: null }, data: { invalidatedAt: new Date() } }),
      prisma.auditLog.create({
        data: {
          shopId: null,
          actorUserId: null,
          actorType: 'SYSTEM',
          action: 'admin.2fa.cli_reset',
          targetType: 'user',
          targetId: user.id,
          metadata: { reason, operator, host: os.hostname(), wasEnabled: !!factor.enabledAt, sessionsEnded: activeSessions }
        }
      })
    ]);
    console.log(`Two-factor authentication removed for ${email}; ${activeSessions} session(s) ended. The admin signs in with their password and should enroll again immediately.`);
    return 0;
  } catch (e) {
    return fail(`failed (${e instanceof Error ? e.name : 'unknown error'}); is DATABASE_URL reachable and migrated?`, 1);
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((c) => process.exit(c));
