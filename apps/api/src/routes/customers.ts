import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword, newToken } from '../auth.js';
import { clearGrantCookie, resolveGrant, type Grant } from '../domain/onboarding-grant.js';
import { loadProfile } from '../domain/profile.js';
import { AppError } from '../errors.js';
import { maskEmail, maskPhone } from '../firebase/verifier.js';
import { clientIpKey, getLimiters } from '../rate-limits.js';
import { authResponseFor, clientParam, deviceIdSchema, requireDeviceForMobile } from './auth-firebase.js';
import { assertSameOrigin } from './auth-phone.js';
import { audit, authenticate, authOf, customerGuard, isUniqueViolation, json, type AppContext } from './context.js';
import { PINCODE } from './profile.js';

/**
 * Marketplace customers (schema-v2 phase 1). POLICY (decisions D1/D5/AD-6, docs/schema-v2/02):
 *  - Off by default (CUSTOMER_SIGNUP_ENABLED=false) so the rollout is flag-controlled.
 *  - A customer exists only after a verified Firebase identity (phone OTP or Google) is exchanged at POST /auth (audience "customer")
 *    and the holder of the restricted grant calls POST /customers/onboarding. No password: passwordSet=false, random unusable hash.
 *  - Identity is resolved ONLY by the Firebase uid. A matching email or phone of an owner/admin never links, signs in or merges anything.
 *    If the Google-verified email already belongs to another account the customer is created WITHOUT an email (nullable, D5): the
 *    request still succeeds and nothing about the other account is revealed.
 *  - The role, activity flag and every identity field are decided here; the client supplies only a display name.
 *  - Idempotent like shop onboarding: a retry of the same verification within the grant's grace window returns the same account.
 */
const onboardingBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    client: clientParam,
    deviceId: deviceIdSchema.optional()
  })
  .strict()
  .superRefine(requireDeviceForMobile);

const RETRY_GRACE_MS = 120_000;

const coordinate = (min: number, max: number) => z.number().finite().min(min).max(max);
const patchBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    addressLine1: z.string().trim().min(2).max(200).optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    pincode: z.string().trim().regex(PINCODE, 'Enter a valid 6-digit PIN code').optional(),
    latitude: coordinate(-90, 90).optional(),
    longitude: coordinate(-180, 180).optional()
  })
  .strict()
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), { message: 'latitude and longitude must be sent together', path: ['latitude'] })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update.' });

export async function customerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  const guard = customerGuard(ctx);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post('/customers/onboarding', { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (request, reply) => {
    const grant = await resolveGrant(ctx, request);
    if (!grant) {
      const session = await authenticate(ctx, request).then(() => true, () => false);
      if (session) throw new AppError(409, 'ALREADY_ONBOARDED', 'This account is already registered.');
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    const body = onboardingBody.parse(request.body);
    if (body.client === 'web') assertSameOrigin(ctx, request);
    const throttleKey = `cust-onboard|${grant.firebaseUid}|${clientIpKey(request.ip)}`;
    if (ctx.loginThrottle.isBlocked(throttleKey)) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');

    const existing = await findExisting(grant);
    if (existing) return respond(request, reply, grant, existing, body.client, 200, body.deviceId);
    if (!config.CUSTOMER_SIGNUP_ENABLED) throw new AppError(403, 'CUSTOMER_SIGNUP_DISABLED', 'Customer sign-up is not open yet.');

    const google = grant.provider === 'google';
    const passwordHash = await hashPassword(newToken());
    const create = (email: string | null) =>
      prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email, displayName: body.name, passwordHash, passwordSet: false, role: 'CUSTOMER', isActive: true }
        });
        await tx.userRoleGrant.create({ data: { userId: user.id, role: 'CUSTOMER' } });
        if (google) {
          await tx.userGoogleIdentity.create({ data: { userId: user.id, firebaseUid: grant.firebaseUid, email: (grant.email ?? '').toLowerCase(), lastAuthTime: grant.authTime, lastSignInAt: new Date() } });
        } else {
          await tx.userPhoneIdentity.create({ data: { userId: user.id, firebaseUid: grant.firebaseUid, phoneE164: grant.phoneE164!, lastAuthTime: grant.authTime, lastSignInAt: new Date() } });
        }
        await audit(tx, {
          shopId: null,
          actorUserId: user.id,
          actorType: 'CUSTOMER',
          action: 'customer.onboarding.created',
          targetType: 'user',
          targetId: user.id,
          metadata: { provider: grant.provider, ...(google ? { email: maskEmail(grant.email ?? '') } : { phone: maskPhone(grant.phoneE164!) }), emailStored: email !== null }
        });
        return user.id;
      });

    try {
      let userId: string;
      try {
        userId = await create(google && grant.email ? grant.email.toLowerCase() : null);
      } catch (error) {
        // The verified email belongs to another account: never merge or reveal it, just register the customer without an email.
        if (!(isUniqueViolation(error, 'email') && google)) throw error;
        userId = await create(null);
      }
      return await respond(request, reply, grant, userId, body.client, 201, body.deviceId);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await findExisting(grant);
      if (raced) return respond(request, reply, grant, raced, body.client, 200, body.deviceId);
      ctx.loginThrottle.recordFailure(throttleKey);
      throw google
        ? new AppError(409, 'GOOGLE_IDENTITY_UNAVAILABLE', 'This Google account cannot be used. Try a different one.')
        : new AppError(409, 'PHONE_UNAVAILABLE', 'This phone number cannot be used. Try a different number.');
    }
  });

  /** The customer previously created from THIS grant's verification, if any; any other existing identity is a conflict (sign in instead). */
  async function findExisting(grant: Grant): Promise<string | null> {
    if (grant.provider === 'google') {
      const identity = await prisma.userGoogleIdentity.findUnique({ where: { firebaseUid: grant.firebaseUid }, include: { user: { select: { passwordSet: true, role: true } } } });
      if (!identity) return null;
      if (identity.lastAuthTime?.getTime() === grant.authTime.getTime() && !identity.user.passwordSet && identity.user.role === 'CUSTOMER') return identity.userId;
      throw new AppError(409, 'ALREADY_ONBOARDED', 'This Google account is already registered. Sign in instead.');
    }
    const identity = await prisma.userPhoneIdentity.findFirst({
      where: { OR: [{ firebaseUid: grant.firebaseUid }, { phoneE164: grant.phoneE164! }] },
      include: { user: { select: { passwordSet: true, role: true } } }
    });
    if (!identity) return null;
    const sameOtp = identity.firebaseUid === grant.firebaseUid && identity.phoneE164 === grant.phoneE164 && identity.lastAuthTime?.getTime() === grant.authTime.getTime();
    if (sameOtp && !identity.user.passwordSet && identity.user.role === 'CUSTOMER') return identity.userId;
    throw new AppError(409, 'ALREADY_ONBOARDED', 'This phone number is already registered. Sign in instead.');
  }

  async function respond(request: FastifyRequest, reply: FastifyReply, grant: Grant, userId: string, client: 'web' | 'mobile', status: 200 | 201, deviceId?: string) {
    const retryUntil = new Date(Date.now() + RETRY_GRACE_MS);
    if (grant.expiresAt > retryUntil) await prisma.phoneOnboardingGrant.updateMany({ where: { id: grant.id }, data: { expiresAt: retryUntil } });
    const out = await authResponseFor(ctx, request, reply, userId, client, deviceId);
    if (client === 'mobile') {
      await prisma.refreshToken.updateMany({
        where: { kind: 'onboarding', subjectUid: grant.firebaseUid, revokedAt: null, ...(deviceId ? { deviceId } : {}) },
        data: { revokedAt: new Date(), revokedReason: 'onboarded' }
      });
    }
    if (client === 'web') clearGrantCookie(ctx, reply);
    reply.code(status);
    return json(out);
  }

  /** The customer's own profile (same derived contract as GET /users/me, role "customer", shops always empty). */
  app.get('/customers/me', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const base = await loadProfile(prisma, config.WEB_ORIGIN, authOf(request).userId);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: authOf(request).userId },
      select: { addressLine1: true, addressLine2: true, city: true, state: true, pincode: true, latitude: true, longitude: true }
    });
    return json({ ...base, customer: row });
  });

  app.patch('/customers/me', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const auth = authOf(request);
    const body = patchBody.parse(request.body);
    const { name, ...rest } = body;
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: auth.userId }, data: { ...(name !== undefined ? { displayName: name } : {}), ...rest } });
      await audit(tx, { shopId: null, actorUserId: auth.userId, actorType: 'CUSTOMER', action: 'customer.profile.updated', targetType: 'user', targetId: auth.userId, metadata: { fields: Object.keys(body) } });
    });
    const base = await loadProfile(prisma, config.WEB_ORIGIN, auth.userId);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { addressLine1: true, addressLine2: true, city: true, state: true, pincode: true, latitude: true, longitude: true }
    });
    return json({ ...base, customer: row });
  });
}
