import { DocumentStatus, Role, type Document, type PrismaClient } from '@prisma/client';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { testPrisma, resetDb } from './helpers/db.js';

export const PASSWORD = 'correct-horse-battery-staple';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    ...process.env,
    LOGIN_RATE_LIMIT_MAX: '1000',
    LOGIN_FAIL_MAX: '1000',
    PUBLIC_RATE_LIMIT_MAX: '1000',
    SSE_HEARTBEAT_MS: '60000',
    ...overrides
  });
}

export function buildApp(overrides: Record<string, string> = {}) {
  const prisma = testPrisma();
  const built = createApp({ config: testConfig(overrides), prisma });
  return { ...built, prisma };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

export interface World {
  planId: string;
  a: { shopId: string; slug: string; ownerEmail: string };
  b: { shopId: string; slug: string; ownerEmail: string };
  adminEmail: string;
}

const RULES = [
  { colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200 },
  { colourMode: 'bw', sides: 'duplex', pricePerSheetPaise: 180 },
  { colourMode: 'colour', sides: 'single', pricePerSheetPaise: 1000 },
  { colourMode: 'colour', sides: 'duplex', pricePerSheetPaise: 900 }
] as const;

/** Two shops (A: "Sharma Print", B: "Metro Copies"), owners, rules, plan and a platform admin. */
export async function seedWorld(prisma: PrismaClient = testPrisma()): Promise<World> {
  await resetDb(prisma);
  const passwordHash = await hashPassword(PASSWORD);
  const plan = await prisma.plan.create({ data: { name: 'Starter', pricePaise: 9900 } });
  const make = async (slug: string, name: string, email: string, multiplier: number) => {
    const shop = await prisma.shop.create({
      data: {
        slug,
        displayName: name,
        settings: { create: {} },
        pricingRules: { create: RULES.map((r) => ({ ...r, pricePerSheetPaise: r.pricePerSheetPaise * multiplier })) },
        subscription: { create: { planId: plan.id } }
      }
    });
    await prisma.user.create({
      data: { email, displayName: `${name} Owner`, passwordHash, role: Role.SHOP_OWNER, shopId: shop.id }
    });
    return { shopId: shop.id, slug, ownerEmail: email };
  };
  const a = await make('sharma-print', 'Sharma Print', 'owner@a.test', 1);
  const b = await make('metro-copies', 'Metro Copies', 'owner@b.test', 2);
  await prisma.user.create({
    data: { email: 'admin@x.test', displayName: 'Admin', passwordHash, role: Role.PLATFORM_ADMIN }
  });
  return { planId: plan.id, a, b, adminEmail: 'admin@x.test' };
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'printout_session');
  if (!cookie) throw new Error('no session cookie');
  const body = res.json().data;
  return { cookie: `printout_session=${cookie.value}`, csrf: body.csrfToken, userId: body.user.id };
}

/** Authenticated request helper; CSRF header added automatically for mutations unless `csrf` is overridden. */
export function call(
  app: FastifyInstance,
  session: Session | null,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  extra: Partial<InjectOptions> = {}
) {
  const headers: Record<string, string> = {};
  if (session) {
    headers.cookie = session.cookie;
    if (method !== 'GET') headers['x-csrf-token'] = session.csrf;
  }
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...headers, ...(extra.headers as Record<string, string> | undefined) },
    ...(body === undefined ? {} : { payload: body as object })
  });
}

export async function createDocument(
  prisma: PrismaClient,
  shopId: string,
  overrides: Partial<{
    pageCount: number;
    status: DocumentStatus;
    expiresAt: Date;
    originalFilename: string;
    printedAt: Date | null;
    deleteAfter: Date | null;
  }> = {}
): Promise<Document> {
  const now = new Date();
  return prisma.document.create({
    data: {
      shopId,
      objectKey: `test-${randomUUID()}`,
      originalFilename: overrides.originalFilename ?? 'notes.pdf',
      detectedMimeType: 'application/pdf',
      byteSize: 1234,
      pageCount: overrides.pageCount ?? 10,
      checksum: 'x',
      status: overrides.status ?? DocumentStatus.AVAILABLE,
      uploadedAt: now,
      expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 24 * 3600e3),
      printedAt: overrides.printedAt ?? null,
      deleteAfter: overrides.deleteAfter ?? null
    }
  });
}

export const baseOptions = {
  paperSize: 'A4',
  colourMode: 'bw',
  sides: 'single',
  copies: 1,
  pageSelection: { mode: 'all' }
} as const;

export async function quoteFor(
  app: FastifyInstance,
  slug: string,
  documentId: string,
  printOptions: unknown = baseOptions
) {
  return app.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/quotes`, payload: { documentId, printOptions } });
}

export async function placeOrder(
  app: FastifyInstance,
  slug: string,
  quoteId: string,
  extra: Record<string, unknown> = {}
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/public/shops/${slug}/orders`,
    payload: { quoteId, clientRequestId: randomUUID(), ...extra }
  });
}

/** Document + quote + order in one go; returns ids and tracking token. */
export async function newOrder(
  app: FastifyInstance,
  prisma: PrismaClient,
  shop: { shopId: string; slug: string },
  printOptions: unknown = baseOptions,
  pageCount = 10
) {
  const doc = await createDocument(prisma, shop.shopId, { pageCount });
  const q = await quoteFor(app, shop.slug, doc.id, printOptions);
  if (q.statusCode !== 200) throw new Error(`quote failed ${q.body}`);
  const o = await placeOrder(app, shop.slug, q.json().data.quoteId);
  if (o.statusCode !== 200) throw new Error(`order failed ${o.body}`);
  const order = await prisma.order.findFirstOrThrow({ where: { trackingToken: o.json().data.trackingToken } });
  return { doc, order, trackingToken: o.json().data.trackingToken as string, quote: q.json().data };
}

/** Walks an order through transitions as the given shop session. */
export async function advance(app: FastifyInstance, session: Session, orderId: string, ...statuses: string[]) {
  for (const toStatus of statuses) {
    const res = await call(app, session, 'POST', `/shop/orders/${orderId}/transitions`, {
      toStatus,
      clientRequestId: randomUUID()
    });
    if (res.statusCode !== 200) throw new Error(`transition to ${toStatus} failed: ${res.body}`);
  }
}
