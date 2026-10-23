import type { Prisma, PrismaClient, Role } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { csrfToken, equalToken, newToken, tokenHash, type LoginThrottle } from '../auth.js';
import type { Config } from '../config.js';
import type { PhoneTokenVerifier } from '../firebase/verifier.js';
import { AppError } from '../errors.js';
import type { ShopEvents } from '../events.js';
import type { ShopNotificationHub } from '../notifications/shop-notifications.js';
import type { Notifier } from '../notifications/types.js';
import type { Storage } from '../storage.js';
import type { TwoFactorKeyring } from '../two-factor/crypto.js';

export interface AppContext {
  config: Config;
  prisma: PrismaClient;
  storage: Storage;
  events: ShopEvents;
  /** Durable shop notifications: post-commit fan-out to open streams (see notifications/shop-notifications.ts). */
  notifications: ShopNotificationHub;
  loginThrottle: LoginThrottle;
  /** Keys for admin two-factor secrets; null when TWO_FACTOR_ENCRYPTION_KEY is unset (2FA unavailable, fail closed for enrolled admins). */
  twoFactorKeys: TwoFactorKeyring | null;
  /** Device push signals (NEW_PRINT_REQUEST etc.). Never carries URLs, keys or credentials. */
  notifier: Notifier;
  /** Firebase phone-token verifier; null when FIREBASE_PROJECT_ID is unset (phone sign-in off). */
  phoneVerifier: PhoneTokenVerifier | null;
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
/**
 * Pending second-factor sign-in. A different cookie NAME and a narrower PATH than the session: it is never sent to,
 * and never read by, any authenticated route (authenticate() only looks at SESSION_COOKIE / the Session table).
 */
export const CHALLENGE_COOKIE = 'printout_2fa';
export const CHALLENGE_COOKIE_PATH = '/api/v1/auth/login/2fa';

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
    /** SHOP_OWNER | SHOP_DEVICE | PLATFORM_ADMIN | SYSTEM. Derived to SHOP_DEVICE / SYSTEM when omitted. */
    actorType?: 'SHOP_OWNER' | 'SHOP_DEVICE' | 'PLATFORM_ADMIN' | 'SYSTEM';
    actorDeviceId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Prisma.InputJsonValue;
  }
) {
  const actorType = entry.actorType ?? (entry.actorDeviceId ? 'SHOP_DEVICE' : entry.actorUserId ? undefined : 'SYSTEM');
  return db.auditLog.create({ data: { ...entry, ...(actorType ? { actorType } : {}) } });
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

/** Rotation: any session presented with this request is ended; a fresh random token is always issued. Returns the CSRF token. */
export async function openSession(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, userId: string): Promise<string> {
  const previous = request.cookies[SESSION_COOKIE];
  if (previous) {
    await ctx.prisma.session.updateMany({ where: { tokenHash: tokenHash(previous), invalidatedAt: null }, data: { invalidatedAt: new Date() } });
  }
  const raw = newToken();
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_DAYS * 86_400_000);
  const session = await ctx.prisma.session.create({ data: { userId, tokenHash: tokenHash(raw), expiresAt } });
  setSessionCookie(ctx, reply, raw, expiresAt);
  return csrfToken(ctx.config.CSRF_SECRET, session.id);
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: ctx.config.NODE_ENV === 'production',
    sameSite: ctx.config.COOKIE_SAMESITE,
    path: COOKIE_PATH
  });
}

export function setChallengeCookie(ctx: AppContext, reply: FastifyReply, raw: string, expires: Date): void {
  reply.setCookie(CHALLENGE_COOKIE, raw, {
    httpOnly: true,
    secure: ctx.config.NODE_ENV === 'production',
    sameSite: ctx.config.COOKIE_SAMESITE,
    path: CHALLENGE_COOKIE_PATH,
    expires
  });
}

export function clearChallengeCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(CHALLENGE_COOKIE, {
    httpOnly: true,
    secure: ctx.config.NODE_ENV === 'production',
    sameSite: ctx.config.COOKIE_SAMESITE,
    path: CHALLENGE_COOKIE_PATH
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
