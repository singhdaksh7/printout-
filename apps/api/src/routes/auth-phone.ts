import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { PhoneTokenInvalidError, PhoneVerifierUnavailableError, maskPhone } from '../firebase/verifier.js';
import { clientIpKey } from '../rate-limits.js';
import { sessionPayload } from './auth.js';
import { audit, json, openSession, type AppContext } from './context.js';

const sessionBody = z.object({ idToken: z.string().min(20).max(4096) }).strict();

export const PHONE_UNAVAILABLE_ERROR = () => new AppError(503, 'PHONE_LOGIN_UNAVAILABLE', 'Phone sign-in is unavailable right now. Sign in with your email and password.');
export const PHONE_TOKEN_INVALID_ERROR = () => new AppError(401, 'PHONE_TOKEN_INVALID', 'That verification could not be confirmed. Request a new code and try again.');

/** Browsers always send Origin on cross-site POSTs; when present it must be our web app (login-CSRF / stray-site guard). */
export function assertSameOrigin(ctx: AppContext, request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  let expected: string;
  try {
    expected = new URL(ctx.config.WEB_ORIGIN).origin;
  } catch {
    expected = ctx.config.WEB_ORIGIN;
  }
  if (origin !== expected) throw new AppError(403, 'FORBIDDEN', 'Request origin is not allowed');
}

/**
 * Exchange of a verified Firebase phone ID token for the normal application session. The phone number is only ever
 * proof of possession: access requires a PRE-EXISTING link (made from Settings after password re-authentication) to a
 * shop owner. The token is verified server side; the browser never supplies user, role or shop identifiers.
 */
export async function authPhoneRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;

  app.get('/auth/phone/config', async () =>
    json({
      enabled: ctx.phoneVerifier !== null,
      allowedCallingCodes: config.PHONE_ALLOWED_CALLING_CODES,
      defaultCallingCode: '+91' as const,
      resendCooldownSeconds: 30
    })
  );

  app.post(
    '/auth/phone/session',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (request, reply) => {
      assertSameOrigin(ctx, request);
      const verifier = ctx.phoneVerifier;
      if (!verifier) throw PHONE_UNAVAILABLE_ERROR();
      const ipKey = `phone|${clientIpKey(request.ip)}`;
      if (ctx.loginThrottle.isBlocked(ipKey)) throw new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.');
      const body = sessionBody.parse(request.body);

      let verified;
      try {
        verified = await verifier.verify(body.idToken);
      } catch (error) {
        if (error instanceof PhoneVerifierUnavailableError) throw PHONE_UNAVAILABLE_ERROR();
        ctx.loginThrottle.recordFailure(ipKey);
        if (error instanceof PhoneTokenInvalidError) throw PHONE_TOKEN_INVALID_ERROR();
        throw PHONE_UNAVAILABLE_ERROR();
      }

      const identity = await prisma.userPhoneIdentity.findUnique({ where: { phoneE164: verified.phoneE164 }, include: { user: { include: { shop: true } } } });
      const notLinked = () => new AppError(403, 'PHONE_NOT_LINKED', 'This phone number is not linked to a shop account. Sign in with your email and password, then add it in Settings.');
      if (!identity) throw notLinked();
      const user = identity.user;
      const refuse = async (reason: string) => {
        await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'auth.phone.login_refused', targetType: 'user', targetId: user.id, metadata: { reason, phone: maskPhone(identity.phoneE164) } });
      };
      // Phone sign-in is for shop owners only; an admin (even if a row somehow existed) is never signed in by SMS alone.
      if (user.role !== 'SHOP_OWNER' || !user.shopId) throw notLinked();
      if (user.shop?.status === 'SUSPENDED') throw new AppError(403, 'SHOP_SUSPENDED', 'This shop is suspended');

      const reverify = async (reason: string) => {
        await refuse(reason);
        return new AppError(403, 'PHONE_REVERIFY_REQUIRED', 'For your security, sign in with your email and password and confirm this phone number again in Settings.');
      };
      // Number recycling: a different Firebase user for the same number (account recreated) or a long-unused link needs the password again.
      if (identity.firebaseUid !== verified.uid) throw await reverify('uid_changed');
      const lastUse = identity.lastSignInAt ?? identity.linkedAt;
      if (Date.now() - lastUse.getTime() > config.PHONE_IDENTITY_MAX_IDLE_DAYS * 86_400_000) throw await reverify('idle');

      // Replay protection: each OTP verification has a strictly later auth_time; a token can be exchanged once.
      const now = new Date();
      const claimed = await prisma.userPhoneIdentity.updateMany({
        where: { id: identity.id, OR: [{ lastAuthTime: null }, { lastAuthTime: { lt: verified.authTime } }] },
        data: { lastAuthTime: verified.authTime, lastSignInAt: now }
      });
      if (claimed.count !== 1) {
        await refuse('replay');
        throw PHONE_TOKEN_INVALID_ERROR();
      }

      ctx.loginThrottle.reset(ipKey);
      const csrf = await openSession(ctx, request, reply, user.id);
      await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'auth.phone.login', targetType: 'user', targetId: user.id, metadata: { phone: maskPhone(identity.phoneE164) } });
      return json(sessionPayload(user, csrf, config.PRINT_RETENTION_MINUTES));
    }
  );
}
