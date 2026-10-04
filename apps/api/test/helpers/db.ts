import { PrismaClient } from '@prisma/client';

export function assertTestDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/_test\b|\/printout_test/.test(url)) throw new Error('Refusing to touch a non-test database');
}

let shared: PrismaClient | undefined;
export function testPrisma() {
  assertTestDatabase();
  return (shared ??= new PrismaClient());
}

/** Empties every application table (keeps _prisma_migrations). Test database only. */
export async function resetDb(prisma = testPrisma()) {
  assertTestDatabase();
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
