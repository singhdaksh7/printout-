import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { endOtherSessions } from '../domain/credentials.js';
import { AppError } from '../errors.js';
import { PhoneTokenInvalidError, PhoneVerifierUnavailableError, maskEmail, maskPhone } from '../firebase/verifier.js';
import { getLimiters } from '../rate-limits.js';
import { GOOGLE_TOKEN_INVALID_ERROR, GOOGLE_UNAVAILABLE_ERROR } from './auth-google.js';
import { audit, authOf, isUniqueViolation, json, shopGuard, type AppContext } from './context.js';
import { reauthenticateOwner } from './shop-reauth.js';

const reauth = z
  .object({ currentPassword: z.string().min(1).max(256).optional(), firebaseIdToken: z.string().min(20).max(4096).optional() })
  .strict();
const linkBody = z.object({ firebaseIdToken: z.string().min(20).max(4096), reauth }).strict();
const unlinkBody = z.object({ reauth }).strict();

const UNAVAILABLE = () => new AppError(409, 'GOOGLE_IDENTITY_UNAVAILABLE', 'This Google account cannot be used. Try a different one.');

/**
 * Explicit, re-authenticated linking of a Google identity to the SIGNED-IN shop owner (cookie+CSRF or Bearer). Both identities are proven:
 *  - the FRESH Google token proves the person owns that Google account (provider google.com, Google-verified email, single use);
 *  - `reauth` proves the existing account (current password, or a fresh token of an identity already linked, e.g. the phone).
 * Nothing is ever linked or merged by matching an email or phone. Every change ends the OTHER sessions and refresh families.
 */
export async function userIdentityRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  const guard = shopGuard(ctx);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/users/me/identities', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: authOf(request).userId }, include: { phoneIdentity: true, googleIdentity: true } });
    return json({
      password: { set: user.passwordSet },
      phone: user.phoneIdentity ? { linked: true as const, phoneMasked: maskPhone(user.phoneIdentity.phoneE164) } : { linked: false as const },
      google: user.googleIdentity ? { linked: true as const, emailMasked: maskEmail(user.googleIdentity.email) } : { linked: false as const },
      googleAvailable: config.GOOGLE_LOGIN_ENABLED && !!ctx.phoneVerifier?.verifyGoogle
    });
  });

  app.post('/users/me/identities/google', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const body = linkBody.parse(request.body);
    const verifier = ctx.phoneVerifier;
    if (!config.GOOGLE_LOGIN_ENABLED || !verifier?.verifyGoogle) throw GOOGLE_UNAVAILABLE_ERROR();
    const auth = authOf(request);
    const tokenKey = `googlelink|${auth.userId}`;
    if (ctx.loginThrottle.isBlocked(tokenKey)) throw new AppError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.');
    // 1) the existing account is proven (password or fresh token of an already-linked identity)
    const user = await reauthenticateOwner(ctx, request, { currentPassword: body.reauth.currentPassword, firebaseIdToken: body.reauth.firebaseIdToken }, 'google_link');
    // 2) the Google identity is proven by a fresh Google token
    let verified;
    try {
      verified = await verifier.verifyGoogle(body.firebaseIdToken);
    } catch (error) {
      if (error instanceof PhoneVerifierUnavailableError) throw GOOGLE_UNAVAILABLE_ERROR();
      ctx.loginThrottle.recordFailure(tokenKey);
      if (error instanceof PhoneTokenInvalidError) throw GOOGLE_TOKEN_INVALID_ERROR();
      throw GOOGLE_UNAVAILABLE_ERROR();
    }
    const masked = maskEmail(verified.email);

    try {
      const out = await prisma.$transaction(async (tx) => {
        const existing = await tx.userGoogleIdentity.findUnique({ where: { userId: user.id } });
        // This Google account already signs in to ANOTHER account: refuse without saying whose.
        const clash = await tx.userGoogleIdentity.findFirst({ where: { userId: { not: user.id }, firebaseUid: verified.uid }, select: { id: true } });
        if (clash) throw UNAVAILABLE();
        const same = !!existing && existing.firebaseUid === verified.uid;
        // A token that was already used (to link or sign in) cannot be used again.
        if (existing && same && existing.lastAuthTime && existing.lastAuthTime >= verified.authTime) throw GOOGLE_TOKEN_INVALID_ERROR();
        const data = { firebaseUid: verified.uid, email: verified.email, linkedAt: new Date(), lastSignInAt: null, lastAuthTime: verified.authTime };
        if (existing) await tx.userGoogleIdentity.update({ where: { id: existing.id }, data });
        else await tx.userGoogleIdentity.create({ data: { userId: user.id, ...data } });
        const replaced = !!existing && !same;
        const ended = await endOtherSessions(tx, user.id, auth.sessionId, 'google_changed');
        await audit(tx, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: replaced ? 'user.google.replaced' : 'user.google.linked', targetType: 'user', targetId: user.id, metadata: { email: masked, otherSessionsEnded: ended } });
        return { replaced, ended, oldUid: replaced ? existing!.firebaseUid : null };
      });
      if (out.oldUid) await verifier.revokeSessions(out.oldUid);
      return json({ linked: true as const, emailMasked: masked, replaced: out.replaced, otherSessionsEnded: out.ended });
    } catch (error) {
      if (isUniqueViolation(error)) throw UNAVAILABLE();
      throw error;
    }
  });

  app.post('/users/me/identities/google/unlink', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const body = unlinkBody.parse(request.body);
    const auth = authOf(request);
    const user = await reauthenticateOwner(ctx, request, { currentPassword: body.reauth.currentPassword, firebaseIdToken: body.reauth.firebaseIdToken }, 'google_unlink');
    const out = await prisma.$transaction(async (tx) => {
      const identity = await tx.userGoogleIdentity.findUnique({ where: { userId: user.id } });
      if (!identity) throw new AppError(404, 'NOT_FOUND', 'No Google account is linked to this account.');
      // Never remove the last way to sign in: a real password or a linked phone must remain.
      const phone = await tx.userPhoneIdentity.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!user.passwordSet && !phone) throw new AppError(409, 'LAST_SIGNIN_METHOD', 'This is your only way to sign in, so it cannot be removed.');
      await tx.userGoogleIdentity.delete({ where: { id: identity.id } });
      const ended = await endOtherSessions(tx, user.id, auth.sessionId, 'google_changed');
      await audit(tx, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'user.google.unlinked', targetType: 'user', targetId: user.id, metadata: { email: maskEmail(identity.email), otherSessionsEnded: ended } });
      return { uid: identity.firebaseUid, ended };
    });
    if (ctx.phoneVerifier) await ctx.phoneVerifier.revokeSessions(out.uid);
    return json({ linked: false as const, otherSessionsEnded: out.ended });
  });
}
