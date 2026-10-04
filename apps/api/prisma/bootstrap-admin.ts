/**
 * Production bootstrap: creates the first PLATFORM_ADMIN (never creates demo data).
 * Reads ADMIN_EMAIL / ADMIN_PASSWORD (+ optional ADMIN_NAME) from the environment. Idempotent:
 * if the user already exists nothing is changed unless ADMIN_RESET_PASSWORD=1.
 * In the container:  node dist/prisma/bootstrap-admin.js
 */
import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../src/auth.js';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('ADMIN_EMAIL is required and must be an email address');
  if (!password || password.length < 12) throw new Error('ADMIN_PASSWORD is required (min 12 characters)');
  if (/change-this|change-me|replace|password123/i.test(password)) throw new Error('ADMIN_PASSWORD looks like a placeholder');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== Role.PLATFORM_ADMIN) throw new Error(`${email} exists but is not a PLATFORM_ADMIN; refusing to change its role`);
    if (process.env.ADMIN_RESET_PASSWORD === '1') {
      await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: await hashPassword(password) } });
      await prisma.session.updateMany({ where: { userId: existing.id, invalidatedAt: null }, data: { invalidatedAt: new Date() } });
      console.log(`Password reset for platform admin ${email}; existing sessions invalidated.`);
    } else {
      console.log(`Platform admin ${email} already exists; nothing to do.`);
    }
    return;
  }
  await prisma.user.create({
    data: { email, displayName: process.env.ADMIN_NAME?.trim() || 'Platform Admin', passwordHash: await hashPassword(password), role: Role.PLATFORM_ADMIN }
  });
  console.log(`Created platform admin ${email}.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
