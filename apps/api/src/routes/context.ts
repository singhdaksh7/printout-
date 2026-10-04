import type { Prisma, PrismaClient, Role } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { csrfToken, equalToken, tokenHash, type LoginThrottle } from '../auth.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { ShopEvents } from '../events.js';
import type { Storage } from '../storage.js';

export interface AppContext {
  config: Config;
  prisma: PrismaClient;
  storage: Storage;
  events: ShopEvents;
  loginThrottle: LoginThrottle;
}

export interface AuthContext {
  userId: string;
  role: Role;
  shopId: string | null;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const SESSION_COOKIE = 'printout_session';
export const COOKIE_PATH = '/api/v1';

export const json = <T>(data: T) => ({ data });

export const idParam = z.object({ id: z.string().min(8).max(64) }).strict();

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Resolves the cookie session. Throws UNAUTHORIZED / SHOP_SUSPENDED. Sets request.auth. */
export async function authenticate(ctx: AppContext, request: FastifyRequest): Promise<AuthContext> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw || raw.length > 200) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const session = await ctx.prisma.session.findFirst({
    where: { tokenHash: tokenHash(raw), invalidatedAt: null, expiresAt: { gt: new Date() } },
    include: { user: { include: { shop: { select: { status: true } } } } }
  });
  if (!session) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (session.user.shop?.status === 'SUSPENDED') {
    throw new AppError(403, 'SHOP_SUSPENDED', 'This shop is suspended');
  }
  const auth: AuthContext = {
    userId: session.user.id,
    role: session.user.role,
    shopId: session.user.shopId,
    sessionId: session.id
  };
  request.auth = auth;
  return auth;
}

/** CSRF check for cookie-authenticated mutations (double-submit of an HMAC bound to the session). */
export function assertCsrf(ctx: AppContext, request: FastifyRequest, auth: AuthContext): void {
  const supplied = request.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || !equalToken(supplied, csrfToken(ctx.config.CSRF_SECRET, auth.sessionId))) {
    throw new AppError(403, 'CSRF_INVALID', 'Invalid CSRF token');
  }
}

/** preHandler for a scope of shop-owner routes: session + tenant + CSRF on every mutating method. */
export function shopGuard(ctx: AppContext) {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = await authenticate(ctx, request);
    if (auth.role !== 'SHOP_OWNER' || !auth.shopId) throw new AppError(403, 'FORBIDDEN', 'Shop account required');
    if (MUTATING.has(request.method)) assertCsrf(ctx, request, auth);
  };
}

/** preHandler for platform-admin scope. */
export function adminGuard(ctx: AppContext) {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = await authenticate(ctx, request);
    if (auth.role !== 'PLATFORM_ADMIN') throw new AppError(403, 'FORBIDDEN', 'Platform admin required');
    if (MUTATING.has(request.method)) assertCsrf(ctx, request, auth);
  };
}

/** Returns the tenant id derived from the session. Never read a shop id from the client. */
export function shopIdOf(request: FastifyRequest): string {
  const shopId = request.auth?.shopId;
  if (!shopId) throw new AppError(403, 'FORBIDDEN', 'Shop account required');
  return shopId;
}

export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return request.auth;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Appends an audit entry. `metadata` must never contain secrets, tokens, passwords or document URLs. */
export function audit(
  db: Db,
  entry: {
    shopId: string | null;
    actorUserId: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Prisma.InputJsonValue;
  }
) {
  return db.auditLog.create({ data: entry });
}

export function isUniqueViolation(error: unknown, field?: string): boolean {
  const e = error as { code?: string; meta?: { target?: string[] | string } } | null;
  if (e?.code !== 'P2002') return false;
  if (!field) return true;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.some((t) => t.includes(field)) : String(target ?? '').includes(field);
}

export function setSessionCookie(ctx: AppContext, reply: FastifyReply, raw: string, expires: Date): void {
  reply.setCookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: ctx.config.NODE_ENV === 'production',
    sameSite: ctx.config.COOKIE_SAMESITE,
    path: COOKIE_PATH,
    expires
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: ctx.config.NODE_ENV === 'production',
    sameSite: ctx.config.COOKIE_SAMESITE,
    path: COOKIE_PATH
  });
}

/** Opaque keyset cursor (createdAt + id). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const [iso, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || typeof id !== 'string') throw new Error('bad');
    return { createdAt, id };
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor');
  }
}

export function cursorWhere(cursor: { createdAt: Date; id: string } | undefined) {
  if (!cursor) return {};
  return {
    OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }]
  };
}
