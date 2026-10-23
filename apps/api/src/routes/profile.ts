import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { qrReadiness } from '../domain/onboarding.js';
import { resolveGrant } from '../domain/onboarding-grant.js';
import { loadProfile, restrictedProfile, type QrInfo } from '../domain/profile.js';
import { AppError } from '../errors.js';
import { fcmKey, registerToken, revokeInstallation, revokeUserToken } from '../notifications/fcm-registrations.js';
import { revokeUserRefreshFamilies } from '../domain/credentials.js';
import { deviceIdSchema } from './auth-firebase.js';
import { getLimiters } from '../rate-limits.js';
import { assertCsrf, audit, authenticate, authOf, isUniqueViolation, json, shopGuard, shopIdOf, type AppContext, type AuthContext } from './context.js';
import { reauthenticateShopOwner } from './shop-reauth.js';

export const PINCODE = /^[1-9][0-9]{5}$/;
const personName = z.string().trim().min(1).max(100);
const email = z.string().trim().max(254).email().transform((v) => v.toLowerCase());

const patchUserBody = z.object({ name: personName.optional(), email: email.optional(), currentPassword: z.string().min(1).max(256).optional() }).strict();
const patchShopBody = z
  .object({
    shopName: z.string().trim().min(2).max(100).optional(),
    address: z.string().trim().min(5).max(300).optional(),
    pincode: z.string().trim().regex(PINCODE, 'Enter a valid 6-digit PIN code').optional()
  })
  .strict();
const fcmToken = z.string().min(20).max(4096).regex(/^\S+$/);
const fcmBody = z.object({ installationId: deviceIdSchema, token: fcmToken, platform: z.enum(['android', 'ios', 'web']) }).strict();
const fcmDeleteBody = z
  .object({ installationId: deviceIdSchema.optional(), token: fcmToken.optional() })
  .strict()
  .refine((b) => (b.installationId === undefined) !== (b.token === undefined), 'Send exactly one of installationId or token');
const EMAIL_UNAVAILABLE = () => new AppError(409, 'EMAIL_UNAVAILABLE', 'This email address cannot be used. Choose a different one.');

/**
 * Shared profile API for Web and Mobile. Every route acts on the caller's OWN account only: ids come from the session
 * (cookie or bearer), never from the request, and there is deliberately no GET /users/:id. Responses are the derived
 * contract in domain/profile.ts; FCM tokens and the Firebase uid are never returned.
 */
export async function profileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  const guard = shopGuard(ctx);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** Any signed-in user (shop owner or admin); CSRF only for cookie transport (bearer is exempt in assertCsrf). */
  const sessionGuard = async (request: FastifyRequest): Promise<void> => {
    const auth = await authenticate(ctx, request);
    if (request.method !== 'GET') assertCsrf(ctx, request, auth);
  };

  type Actor = { kind: 'session'; auth: AuthContext } | { kind: 'grant'; provider: 'phone' | 'google'; phoneE164: string | null; email: string | null };
  /** A session (suspended shops included, so clients can show account_blocked) or the restricted onboarding grant. */
  async function actorOf(request: FastifyRequest): Promise<Actor> {
    try {
      return { kind: 'session', auth: await authenticate(ctx, request, { allowSuspended: true }) };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'UNAUTHORIZED') throw error;
    }
    const grant = await resolveGrant(ctx, request);
    if (grant) return { kind: 'grant', provider: grant.provider, phoneE164: grant.phoneE164, email: grant.email };
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  app.get('/users/me', async (request, reply) => {
    const actor = await actorOf(request);
    await limits.shopRead(request, reply);
    if (actor.kind === 'grant') return json(restrictedProfile({ provider: actor.provider, phone: actor.phoneE164, email: actor.email }));
    return json(await loadProfile(prisma, config.WEB_ORIGIN, actor.auth.userId));
  });

  app.patch('/users/me', { preHandler: [sessionGuard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const body = patchUserBody.parse(request.body);
    if (body.name === undefined && body.email === undefined) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update.');
    const current = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, email: true, role: true, passwordSet: true, shopId: true } });
    const fields: string[] = [];
    const data: { displayName?: string; email?: string } = {};
    if (body.name !== undefined) {
      data.displayName = body.name;
      fields.push('name');
    }
    let emailChanged = false;
    if (body.email !== undefined && body.email !== current.email) {
      // The email is a sign-in identifier: only a shop owner who still has a real password may change it, and only after re-entering it.
      if (current.role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'Use the admin account page to change your email.');
      if (!current.passwordSet) throw new AppError(403, 'EMAIL_CHANGE_NOT_ALLOWED', 'This account has no password, so its email cannot be changed here. Contact support.');
      if (!body.currentPassword) throw new AppError(400, 'VALIDATION_ERROR', 'Enter your current password to change your email.', { field: 'currentPassword' });
      await reauthenticateShopOwner(ctx, request, body.currentPassword, 'email_change');
      data.email = body.email;
      emailChanged = true;
      fields.push('email');
    }
    if (fields.length === 0) return json(await loadProfile(prisma, config.WEB_ORIGIN, auth.userId));
    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: auth.userId }, data });
        // A changed sign-in identifier ends every OTHER session; this one stays.
        const ended = emailChanged ? (await tx.session.updateMany({ where: { userId: auth.userId, invalidatedAt: null, id: { not: auth.sessionId } }, data: { invalidatedAt: new Date() } })).count : 0;
        if (emailChanged) await revokeUserRefreshFamilies(tx, auth.userId, 'email_changed', (await tx.session.findUnique({ where: { id: auth.sessionId }, select: { familyId: true } }))?.familyId ?? null);
        await audit(tx, { shopId: current.shopId, actorUserId: auth.userId, actorType: current.role === 'PLATFORM_ADMIN' ? 'PLATFORM_ADMIN' : 'SHOP_OWNER', action: 'user.profile.updated', targetType: 'user', targetId: auth.userId, metadata: { fields, otherSessionsEnded: ended } });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw EMAIL_UNAVAILABLE();
      throw error;
    }
    return json(await loadProfile(prisma, config.WEB_ORIGIN, auth.userId));
  });

  /** The caller's shops (zero or one: single-shop data model), the default shop (singular, for compatibility) and the default shop's state. */
  const shopsView = (view: Awaited<ReturnType<typeof loadProfile>>) => ({
    shops: view.shops,
    shop: view.shop,
    nextStep: view.nextStep,
    isShopRegisteredAtLeastOne: view.isShopRegisteredAtLeastOne,
    showQr: view.showQr
  });

  app.get('/shops/me', { preHandler: [guard, limits.shopRead] }, async (request) => {
    return json(shopsView(await loadProfile(prisma, config.WEB_ORIGIN, authOf(request).userId)));
  });

  app.patch('/shops/me', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const shopId = shopIdOf(request);
    const body = patchShopBody.parse(request.body);
    const data: { displayName?: string; address?: string; pincode?: string } = {};
    if (body.shopName !== undefined) data.displayName = body.shopName;
    if (body.address !== undefined) data.address = body.address;
    if (body.pincode !== undefined) data.pincode = body.pincode;
    if (Object.keys(data).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update.');
    await prisma.$transaction(async (tx) => {
      await tx.shop.update({ where: { id: shopId }, data });
      await audit(tx, { shopId, actorUserId: auth.userId, actorType: 'SHOP_OWNER', action: 'shop.profile.updated', targetType: 'shop', targetId: shopId, metadata: { fields: Object.keys(body) } });
    });
    return json(shopsView(await loadProfile(prisma, config.WEB_ORIGIN, auth.userId)));
  });

  /** Readiness of the public QR destination. Virtual: derived from the slug, never stored, so there is nothing to regenerate at login. */
  app.get('/shops/me/qr', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const { shopId: wanted } = z.object({ shopId: z.string().min(8).max(64).optional() }).strict().parse(request.query);
    const ownShopId = shopIdOf(request);
    // Optional selector restricted to shops the caller is authorized for (today only their own); anything else is a generic 404.
    if (wanted !== undefined && wanted !== ownShopId) throw new AppError(404, 'NOT_FOUND', 'Shop not found');
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: ownShopId }, select: { slug: true, status: true } });
    const qr = qrReadiness(shop, config.WEB_ORIGIN);
    const out: QrInfo = { ready: qr.ready, publicUrl: qr.publicUrl, qrCodeUrl: qr.publicUrl, reason: qr.reason };
    return json(out);
  });

  // FCM registration: sensitive device identifier, isolated from every profile response and from audit metadata. Rows are ALWAYS
  // scoped by the session's user id: an installationId or token never reaches another user's registration.
  const fcmGuard = async (request: FastifyRequest): Promise<void> => {
    await sessionGuard(request);
    // Push is for shop owners' devices; an admin session may not register.
    if (authOf(request).role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'Push registration is only available to shop accounts.');
  };

  app.put('/users/me/fcm-token', { preHandler: [fcmGuard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const body = fcmBody.parse(request.body);
    const key = fcmKey(config);
    const run = () => registerToken(prisma, key, { userId: auth.userId, shopId: auth.shopId, installationId: body.installationId, platform: body.platform, token: body.token });
    let outcome: { moved: boolean; evicted: number };
    try {
      outcome = await run();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      outcome = await run(); // lost a race with an identical concurrent registration
    }
    await audit(prisma, { shopId: auth.shopId, actorUserId: auth.userId, actorType: 'SHOP_OWNER', action: 'user.fcm_token.registered', targetType: 'user', targetId: auth.userId, metadata: { platform: body.platform, moved: outcome.moved, evicted: outcome.evicted } });
    return json({ registered: true as const, installationId: body.installationId, platform: body.platform });
  });

  app.delete('/users/me/fcm-token', { preHandler: [fcmGuard, limits.shopMutation] }, async (request, reply) => {
    const auth = authOf(request);
    const body = fcmDeleteBody.parse(request.body);
    // Only the caller's own registration is touched; absent or someone else's answers the same 204 (no probing).
    const removed = body.installationId ? await revokeInstallation(prisma, auth.userId, body.installationId) : await revokeUserToken(prisma, auth.userId, body.token!);
    if (removed > 0) await audit(prisma, { shopId: auth.shopId, actorUserId: auth.userId, actorType: 'SHOP_OWNER', action: 'user.fcm_token.removed', targetType: 'user', targetId: auth.userId });
    return reply.code(204).send();
  });
}
