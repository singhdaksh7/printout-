import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword, newToken } from '../auth.js';
import { resolveGrant, clearGrantCookie, type Grant } from '../domain/onboarding-grant.js';
import { AppError } from '../errors.js';
import { maskEmail, maskPhone } from '../firebase/verifier.js';
import { clientIpKey } from '../rate-limits.js';
import { assertSameOrigin } from './auth-phone.js';
import { authResponseFor, clientParam, deviceIdSchema, requireDeviceForMobile } from './auth-firebase.js';
import { audit, authenticate, isUniqueViolation, json, type AppContext } from './context.js';
import { PINCODE } from './profile.js';

/**
 * Self-onboarding POLICY (decision recorded here and in docs/MOBILE_AUTH_API.md):
 *  - Off by default (SHOP_SELF_ONBOARDING_ENABLED=false). A verified identity with no linked account is then only told to ask for one.
 *  - When on, a holder of the restricted onboarding principal (issued by POST /auth or the exchange after a verified OTP / Google sign-in)
 *    may create ONE shop. The shop is a PILOT: no subscription/plan, acceptsOrders=false, not publicly orderable and the QR is not ready
 *    until a platform admin activates it. The new owner can configure the shop but receives no premium status, plan, price, referral award
 *    or verification flag. Role, status, plan, registeredBy and "verified" are decided here, never by the client (unknown keys are ignored).
 *  - The owner has NO usable password (passwordSet=false): the verified identity (phone OTP or Google) is the sign-in method until support
 *    sets credentials. For a Google principal the account email IS the Google-verified email (a body email must be absent or equal it);
 *    if that email already belongs to an existing user the answer is the generic 409 EMAIL_UNAVAILABLE (sign in with the existing method and
 *    LINK Google explicitly; accounts are never merged by matching an email).
 *  - Idempotent: user, shop and verified identity are created in ONE transaction and the unique constraints make concurrent attempts yield
 *    exactly one shop; a retry within the grant's grace window returns the same shop.
 */
const onboardingBody = z
  .object({
    ownerName: z.string().trim().min(1).max(100),
    /** Phone principals: required. Google principals: absent or equal to the verified email. */
    email: z.string().trim().max(254).email().transform((v) => v.toLowerCase()).optional(),
    shopName: z.string().trim().min(2).max(100),
    address: z.string().trim().min(5).max(300),
    pincode: z.string().trim().regex(PINCODE, 'Enter a valid 6-digit PIN code'),
    client: clientParam,
    deviceId: deviceIdSchema.optional()
  })
  .superRefine(requireDeviceForMobile);

/** After success the grant lives only this long, so a lost response can be retried idempotently without keeping a restricted token around. */
const RETRY_GRACE_MS = 120_000;
const SLUG_ATTEMPTS = 5;

function slugBase(shopName: string): string {
  const base = shopName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return base.length >= 3 ? base : 'shop';
}
const newSlug = (shopName: string) => `${slugBase(shopName)}-${randomInt(36 ** 4).toString(36).padStart(4, '0')}`;

export async function shopOnboardingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;

  app.post(
    '/shops/onboarding',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const grant = await resolveGrant(ctx, request);
      if (!grant) {
        // A signed-in owner calling this is not "unauthenticated": say so instead of inviting a retry loop.
        const session = await authenticate(ctx, request).then(() => true, () => false);
        if (session) throw new AppError(409, 'ALREADY_ONBOARDED', 'This account already has a shop.');
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      }
      const body = onboardingBody.parse(request.body);
      // Cookie transport: strict Origin check (the grant cookie is ambient). Bearer transport is not ambient.
      if (body.client === 'web') assertSameOrigin(ctx, request);
      const google = grant.provider === 'google';
      // The account email: from the verified Google identity, or (phone principals) from the body. Never trusted from the client for Google.
      let accountEmail: string;
      if (google) {
        accountEmail = (grant.email ?? '').toLowerCase();
        if (!accountEmail) throw new AppError(409, 'ALREADY_ONBOARDED', 'This sign-in cannot create a shop.');
        if (body.email !== undefined && body.email !== accountEmail) throw new AppError(400, 'VALIDATION_ERROR', 'email must be omitted or equal to the verified Google email', { field: 'email' });
      } else {
        if (!body.email) throw new AppError(400, 'VALIDATION_ERROR', 'email is required', { field: 'email' });
        accountEmail = body.email;
      }
      const throttleKey = `onboard|${grant.firebaseUid}|${clientIpKey(request.ip)}`;
      if (ctx.loginThrottle.isBlocked(throttleKey)) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');

      const existing = await findExisting(grant);
      if (existing) return respond(request, reply, grant, existing, body.client, 200, body.deviceId);

      if (!config.SHOP_SELF_ONBOARDING_ENABLED) throw new AppError(403, 'SELF_ONBOARDING_DISABLED', 'Shop registration is not open yet. Contact Printout Buddy to get your shop set up.');

      const passwordHash = await hashPassword(newToken()); // random, never disclosed: the account has no password sign-in
      for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
        try {
          const userId = await prisma.$transaction(async (tx) => {
            const shop = await tx.shop.create({
              data: { slug: newSlug(body.shopName), displayName: body.shopName, address: body.address, pincode: body.pincode, status: 'ACTIVE', acceptsOrders: true, settings: { create: {} } }
            });
            const user = await tx.user.create({
              data: { email: accountEmail, displayName: body.ownerName, passwordHash, passwordSet: false, role: 'SHOP_OWNER', shopId: shop.id }
            });
            if (google) {
              await tx.userGoogleIdentity.create({ data: { userId: user.id, firebaseUid: grant.firebaseUid, email: accountEmail, lastAuthTime: grant.authTime, lastSignInAt: new Date() } });
            } else {
              await tx.userPhoneIdentity.create({ data: { userId: user.id, firebaseUid: grant.firebaseUid, phoneE164: grant.phoneE164!, lastAuthTime: grant.authTime, lastSignInAt: new Date() } });
            }
            await audit(tx, {
              shopId: shop.id,
              actorUserId: user.id,
              actorType: 'SHOP_OWNER',
              action: 'shop.onboarding.created',
              targetType: 'shop',
              targetId: shop.id,
              metadata: { slug: shop.slug, provider: grant.provider, ...(google ? { email: maskEmail(accountEmail) } : { phone: maskPhone(grant.phoneE164!) }), selfService: true }
            });
            return user.id;
          });
          return await respond(request, reply, grant, userId, body.client, 201, body.deviceId);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          if (isUniqueViolation(error, 'slug')) continue;
          // Someone (a concurrent identical request) created this identity first: that is the idempotent outcome.
          const raced = await findExisting(grant);
          if (raced) return respond(request, reply, grant, raced, body.client, 200, body.deviceId);
          if (isUniqueViolation(error, 'email')) {
            ctx.loginThrottle.recordFailure(throttleKey);
            throw new AppError(409, 'EMAIL_UNAVAILABLE', 'This email address cannot be used. Choose a different one.');
          }
          throw google
            ? new AppError(409, 'GOOGLE_IDENTITY_UNAVAILABLE', 'This Google account cannot be used. Try a different one.')
            : new AppError(409, 'PHONE_UNAVAILABLE', 'This phone number cannot be used. Try a different number.');
        }
      }
      throw new AppError(409, 'CONFLICT', 'Could not reserve a shop address. Try again.');
    }
  );

  /**
   * The user previously created from THIS grant's identity, if any. A grant may never mint a session for an account it did not
   * create: only a self-onboarded owner (passwordSet=false) whose verification is this grant's verification qualifies; anything else is a conflict.
   */
  async function findExisting(grant: Grant): Promise<string | null> {
    if (grant.provider === 'google') {
      const identity = await prisma.userGoogleIdentity.findUnique({ where: { firebaseUid: grant.firebaseUid }, include: { user: { select: { passwordSet: true } } } });
      if (!identity) return null;
      if (identity.lastAuthTime?.getTime() === grant.authTime.getTime() && !identity.user.passwordSet) return identity.userId;
      throw new AppError(409, 'ALREADY_ONBOARDED', 'This Google account is already registered. Sign in instead.');
    }
    const identity = await prisma.userPhoneIdentity.findFirst({
      where: { OR: [{ firebaseUid: grant.firebaseUid }, { phoneE164: grant.phoneE164! }] },
      include: { user: { select: { passwordSet: true } } }
    });
    if (!identity) return null;
    const sameOtp = identity.firebaseUid === grant.firebaseUid && identity.phoneE164 === grant.phoneE164 && identity.lastAuthTime?.getTime() === grant.authTime.getTime();
    if (sameOtp && !identity.user.passwordSet) return identity.userId;
    throw new AppError(409, 'ALREADY_ONBOARDED', 'This phone number is already registered. Sign in instead.');
  }

  async function respond(request: FastifyRequest, reply: FastifyReply, grant: Grant, userId: string, client: 'web' | 'mobile', status: 200 | 201, deviceId?: string) {
    // Shrink the restricted grant to a short retry window instead of leaving it valid for its full lifetime.
    const retryUntil = new Date(Date.now() + RETRY_GRACE_MS);
    if (grant.expiresAt > retryUntil) await prisma.phoneOnboardingGrant.updateMany({ where: { id: grant.id }, data: { expiresAt: retryUntil } });
    const out = await authResponseFor(ctx, request, reply, userId, client, deviceId);
    // The restricted refresh tokens are spent: from now on this installation holds the account's own pair. The (shrunken) grant is left to
    // expire by itself so a retry after a lost response is still answered idempotently.
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
}
