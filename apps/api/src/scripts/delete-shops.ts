/**
 * Operator script: delete every shop EXCEPT the ones named in --keep (same deletion as the admin API).
 *
 *   node dist/src/scripts/delete-shops.js --keep slug1,slug2             # DRY RUN (default): prints, changes nothing
 *   node dist/src/scripts/delete-shops.js --keep slug1,slug2 --execute   # deletes, one transaction per shop
 *   (from source: corepack pnpm --filter @printout/api shops:delete -- --keep a,b [--execute] [--force])
 *
 * Controls: --keep is required; if it matches fewer shops than the slugs given (typo guard) nothing runs (exit 2); a kept shop is
 * never deleted; shops with in-flight work are skipped unless --force; a failure on one shop is reported and the run continues.
 * One surviving audit row per deleted shop (actor SYSTEM, no personal data). Owner accounts: see domain/shop-delete.ts; owners of
 * kept shops are never deleted. Prints counts only. Exit: 0 ok, 1 at least one shop failed, 2 refused.
 */
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { deleteShopCompletely, hasActiveWork, planShopDeletion, type ShopDeleteContext } from '../domain/shop-delete.js';
import { AppError } from '../errors.js';
import { createStorage, type StorageConfig } from '../storage/index.js';

export interface DeleteShopsArgs {
  keep: string[];
  execute: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): DeleteShopsArgs | string {
  let keepRaw: string | undefined;
  let execute = false;
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--execute') execute = true;
    else if (a === '--force') force = true;
    else if (a === '--keep') keepRaw = argv[(i += 1)];
    else if (a.startsWith('--keep=')) keepRaw = a.slice('--keep='.length);
    else return `unknown argument ${a}`;
  }
  const keep = [...new Set((keepRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (keep.length === 0) return '--keep slug1,slug2 is required';
  return { keep, execute, force };
}

export async function runDeleteShops(
  args: DeleteShopsArgs,
  ctx: ShopDeleteContext,
  out: (line: string) => void = console.log
): Promise<0 | 1 | 2> {
  const { prisma } = ctx;
  const kept = await prisma.shop.findMany({ where: { slug: { in: args.keep } }, select: { id: true, slug: true, displayName: true, status: true } });
  if (kept.length < args.keep.length) {
    const found = new Set(kept.map((s) => s.slug));
    out(`REFUSED: --keep names shops that do not exist: ${args.keep.filter((s) => !found.has(s)).join(', ')}. Nothing was changed.`);
    return 2;
  }
  const keptIds = new Set(kept.map((s) => s.id));
  const targets = await prisma.shop.findMany({ where: { id: { notIn: [...keptIds] } }, orderBy: { createdAt: 'asc' }, select: { id: true, slug: true } });
  if (targets.some((t) => keptIds.has(t.id))) {
    out('REFUSED: internal guard, a kept shop is in the delete list.');
    return 2;
  }
  const protectedUsers = await prisma.user.findMany({
    where: { OR: [{ shopId: { in: [...keptIds] } }, { memberships: { some: { shopId: { in: [...keptIds] } } } }] },
    select: { id: true }
  });
  const protectedUserIds = protectedUsers.map((u) => u.id);

  out(args.execute ? 'MODE: EXECUTE (deleting)' : 'MODE: DRY RUN (nothing will be changed; add --execute to delete)');
  out(`Keeping ${kept.length} shop(s):`);
  for (const s of kept) out(`  KEEP   ${s.slug} | ${s.displayName} | ${s.status}`);
  out(`Shops to delete: ${targets.length}`);

  let failed = 0;
  let deleted = 0;
  let skipped = 0;
  const marker = 'operator-script';
  for (const t of targets) {
    try {
      const plan = await planShopDeletion(prisma, t.id);
      const nonZero = Object.entries(plan.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ') || 'no rows';
      out(`  DELETE ${plan.shop.slug} | ${plan.shop.displayName} | ${plan.shop.status}`);
      out(`         rows: ${nonZero}`);
      out(`         storage objects: documents=${plan.storageObjects.documents} images=${plan.storageObjects.images}`);
      const busy = hasActiveWork(plan.activeWork);
      if (busy) out(`         WARNING in-flight work: orders=${plan.activeWork.activeOrders} deviceJobs=${plan.activeWork.activeDevicePrintJobs} printJobs=${plan.activeWork.activePrintJobs}${args.force ? ' (--force)' : ' (will be skipped without --force)'}`);
      if (!args.execute) continue;
      if (busy && !args.force) {
        skipped += 1;
        out('         SKIPPED (in-flight work)');
        continue;
      }
      const r = await deleteShopCompletely(ctx, t.id, { actor: { type: 'SYSTEM', marker }, force: args.force, protectedUserIds, via: 'operator_script' });
      deleted += 1;
      out(`         DELETED owners deleted=${r.owners.deleted} detached=${r.owners.detached} orphanedObjects=${r.orphanedObjects}`);
    } catch (error) {
      failed += 1;
      out(`         FAILED ${error instanceof AppError ? error.code : error instanceof Error ? error.name : 'unknown'}`);
    }
  }
  out(
    args.execute
      ? `SUMMARY: deleted=${deleted} skipped=${skipped} failed=${failed} kept=${kept.length}`
      : `SUMMARY (dry run): would delete ${targets.length}, keep ${kept.length}. No changes made.`
  );
  return failed > 0 || skipped > 0 ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`delete-shops: ${parsed}`);
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const config = loadConfig(process.env);
  const storage = createStorage({ ...(process.env as Record<string, string>), ...config } as unknown as StorageConfig);
  runDeleteShops(parsed, { prisma, storage })
    .then(async (code) => {
      await prisma.$disconnect();
      process.exit(code);
    })
    .catch(async (error) => {
      console.error(`delete-shops: ${error instanceof Error ? error.name : 'failed'}`);
      await prisma.$disconnect();
      process.exit(1);
    });
}
