/**
 * Idempotent development seed: two demo shops (+owners), one platform admin, a Rs 99 plan and
 * subscriptions. Safe to run repeatedly; existing rows are left untouched except pricing rules/plan
 * which are upserted. Password comes from SEED_PASSWORD (documented dev default below).
 */
import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../src/auth.js';

const DEV_DEFAULT_PASSWORD = 'change-this-development-password';
const prisma = new PrismaClient();

const SHOPS = [
  { slug: 'central-print', name: 'Central Print', email: 'owner@central.test' },
  { slug: 'metro-copies', name: 'Metro Copies', email: 'owner@metro.test' }
] as const;

const RULES = [
  { colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200 },
  { colourMode: 'bw', sides: 'duplex', pricePerSheetPaise: 180 },
  { colourMode: 'colour', sides: 'single', pricePerSheetPaise: 1000 },
  { colourMode: 'colour', sides: 'duplex', pricePerSheetPaise: 900 }
] as const;

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_PASSWORD) {
    throw new Error('Refusing to seed production without SEED_PASSWORD');
  }
  const password = process.env.SEED_PASSWORD ?? DEV_DEFAULT_PASSWORD;
  const passwordHash = await hashPassword(password);

  const plan = await prisma.plan.upsert({
    where: { name: 'Printout Starter' },
    update: { pricePaise: 9900 },
    create: { name: 'Printout Starter', pricePaise: 9900 }
  });

  for (const s of SHOPS) {
    const shop = await prisma.shop.upsert({
      where: { slug: s.slug },
      update: {},
      create: { slug: s.slug, displayName: s.name, settings: { create: {} } }
    });
    await prisma.shopSettings.upsert({ where: { shopId: shop.id }, update: {}, create: { shopId: shop.id } });
    for (const r of RULES) {
      await prisma.pricingRule.upsert({
        where: { shopId_paperSize_colourMode_sides: { shopId: shop.id, paperSize: 'A4', colourMode: r.colourMode, sides: r.sides } },
        update: {},
        create: { shopId: shop.id, ...r }
      });
    }
    await prisma.user.upsert({
      where: { email: s.email },
      update: {},
      create: { email: s.email, displayName: `${s.name} Owner`, passwordHash, role: Role.SHOP_OWNER, shopId: shop.id }
    });
    await prisma.subscription.upsert({
      where: { shopId: shop.id },
      update: {},
      create: { shopId: shop.id, planId: plan.id }
    });
  }

  await prisma.user.upsert({
    where: { email: 'admin@printout.test' },
    update: {},
    create: { email: 'admin@printout.test', displayName: 'Platform Admin', passwordHash, role: Role.PLATFORM_ADMIN }
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log('\nSeeded demo accounts (development only):');
    for (const s of SHOPS) console.log(`  shop owner  ${s.email}  /p/${s.slug}`);
    console.log('  platform    admin@printout.test');
    console.log(`  password    ${password === DEV_DEFAULT_PASSWORD ? `${password} (dev default; set SEED_PASSWORD to override)` : '(from SEED_PASSWORD)'}\n`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
