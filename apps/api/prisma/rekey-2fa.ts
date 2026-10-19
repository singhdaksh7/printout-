/**
 * Re-seal every stored TOTP secret under the CURRENT encryption key (key rotation).
 *
 *   1. Generate a new key:  openssl rand -base64 32
 *   2. Deploy with TWO_FACTOR_ENCRYPTION_KEY=<new>  and  TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS=<old>   (both keys known)
 *   3. Run this script with the same two variables:   corepack pnpm admin:2fa-rekey
 *   4. When it reports 0 rows left on an old key, remove TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS and redeploy.
 *
 * - DATABASE_URL must be set explicitly. DRY_RUN=1 only counts.
 * - Each row is rewritten with a compare-and-swap, so a concurrent change is never overwritten.
 * - A row that cannot be opened with the configured keys aborts with exit 2 BEFORE anything is written.
 * - Prints counts only. Never prints a key, a secret or a ciphertext. Exit: 0 ok, 1 runtime failure, 2 refused.
 */
import { PrismaClient } from '@prisma/client';
import { buildKeyring, openSecret, sealSecret, TwoFactorKeyError } from '../src/two-factor/crypto.js';

async function main(): Promise<number> {
  const fail = (m: string, code: 1 | 2 = 2) => {
    console.error(`rekey-2fa: ${m}`);
    return code;
  };
  if (!process.env.DATABASE_URL?.trim()) return fail('DATABASE_URL must be set explicitly');
  const primary = process.env.TWO_FACTOR_ENCRYPTION_KEY?.trim();
  if (!primary) return fail('TWO_FACTOR_ENCRYPTION_KEY must be set');
  const dryRun = ['1', 'true', 'yes'].includes((process.env.DRY_RUN ?? '').toLowerCase());
  let ring;
  try {
    ring = buildKeyring(primary, process.env.TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS);
  } catch (e) {
    return fail(e instanceof TwoFactorKeyError ? e.message : 'invalid key configuration');
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.adminTwoFactor.findMany({ select: { userId: true, secretEnc: true, keyId: true } });
    const stale = rows.filter((r) => r.keyId !== ring.primary.id);
    const resealed: Array<{ userId: string; old: string; sealed: string; keyId: string }> = [];
    for (const row of stale) {
      let plain: Buffer;
      try {
        plain = openSecret(ring, row.userId, row.secretEnc);
      } catch {
        return fail(`${row.userId}: secret cannot be opened with the configured keys; add the missing key to TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS. Nothing was written.`);
      }
      resealed.push({ userId: row.userId, old: row.secretEnc, ...sealSecret(ring, row.userId, plain) });
      plain.fill(0);
    }
    if (dryRun) {
      console.log(`DRY RUN: ${rows.length} enrollment(s), ${stale.length} need re-sealing. Nothing changed.`);
      return 0;
    }
    let updated = 0;
    for (const item of resealed) {
      const result = await prisma.adminTwoFactor.updateMany({ where: { userId: item.userId, secretEnc: item.old }, data: { secretEnc: item.sealed, keyId: item.keyId } });
      updated += result.count;
    }
    if (updated > 0) {
      await prisma.auditLog.create({
        data: { shopId: null, actorUserId: null, actorType: 'SYSTEM', action: 'admin.2fa.rekey', targetType: 'system', metadata: { rowsResealed: updated } }
      });
    }
    const remaining = await prisma.adminTwoFactor.count({ where: { keyId: { not: ring.primary.id } } });
    console.log(`Re-sealed ${updated} of ${stale.length} stale enrollment(s); ${remaining} row(s) still on an old key.`);
    return 0;
  } catch (e) {
    return fail(`failed (${e instanceof Error ? e.name : 'unknown error'}); is DATABASE_URL reachable and migrated?`, 1);
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((c) => process.exit(c));
