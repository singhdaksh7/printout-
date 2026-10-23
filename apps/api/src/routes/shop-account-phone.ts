import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { revokeUserRefreshFamilies } from '../domain/credentials.js';
import { AppError } from '../errors.js';
import { PhoneTokenInvalidError, PhoneVerifierUnavailableError, maskPhone } from '../firebase/verifier.js';
import { getLimiters } from '../rate-limits.js';
import { PHONE_TOKEN_INVALID_ERROR, PHONE_UNAVAILABLE_ERROR } from './auth-phone.js';
import { audit, authOf, isUniqueViolation, json, shopGuard, type AppContext } from './context.js';
import { reauthenticateOwner } from './shop-reauth.js';

const currentPassword = z.string().min(1).max(256);
/** Proof of ownership: the current password (as always), or a fresh token of another identity already linked to this account (accounts without a password). */
const proofFields = { currentPassword: currentPassword.optional(), reauthIdToken: z.string().min(20).max(4096).optional() };
const linkBody = z.object({ idToken: z.string().min(20).max(4096), ...proofFields }).strict();
const unlinkBody = z.object(proofFields).strict();

const UNAVAILABLE = () => new AppError(409, 'PHONE_UNAVAILABLE', 'This phone number cannot be used. Try a different number.');

/**
 * Self-service linking of a Firebase-verified phone number to the SIGNED-IN shop owner. Linking, replacing and unlinking
 * need the current password (recent re-authentication) AND, for linking, a fresh OTP verification. The account is always
 * the session's own; the browser cannot name a user or shop. Other sessions end on every change; the password remains.
 */
export async function shopAccountPhoneRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  const guard = shopGuard(ctx);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** Ends every other session and (mobile) refresh family of the owner; the current session and its family stay. */
  const endOtherSessions = async (db: Pick<typeof prisma, 'session' | 'refreshToken'>, userId: string, sessionId: string) => {
    const current = await db.session.findUnique({ where: { id: sessionId }, select: { familyId: true } });
    const count = (await db.session.updateMany({ where: { userId, invalidatedAt: null, id: { not: sessionId } }, data: { invalidatedAt: new Date() } })).count;
    await revokeUserRefreshFamilies(db as typeof prisma, userId, 'phone_changed', current?.familyId ?? null);
    return count;
  };

  app.get('/shop/account/phone', { preHandler: [guard, limits.shopRead] }, async (request) => {
    const auth = authOf(request);
    const identity = await prisma.userPhoneIdentity.findUnique({ where: { userId: auth.userId } });
    const available = ctx.phoneVerifier !== null;
    if (!identity) return json({ linked: false as const, available });
    return json({ linked: true as const, phoneMasked: maskPhone(identity.phoneE164), linkedAt: identity.linkedAt, lastSignInAt: identity.lastSignInAt, available });
  });

  app.post('/shop/account/phone', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const body = linkBody.parse(request.body);
    const verifier = ctx.phoneVerifier;
    if (!verifier) throw PHONE_UNAVAILABLE_ERROR();
    const auth = authOf(request);
    const user = await reauthenticateOwner(ctx, request, { currentPassword: body.currentPassword, firebaseIdToken: body.reauthIdToken }, 'phone_link');

    const tokenKey = `phonelink|${user.id}`;
    if (ctx.loginThrottle.isBlocked(tokenKey)) throw new AppError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.');
    let verified;
    try {
      verified = await verifier.verify(body.idToken);
    } catch (error) {
      if (error instanceof PhoneVerifierUnavailableError) throw PHONE_UNAVAILABLE_ERROR();
      ctx.loginThrottle.recordFailure(tokenKey);
      if (error instanceof PhoneTokenInvalidError) throw PHONE_TOKEN_INVALID_ERROR();
      throw PHONE_UNAVAILABLE_ERROR();
    }
    const masked = maskPhone(verified.phoneE164);

    let result: { replaced: boolean; otherSessionsEnded: number; oldUid: string | null };
    try {
      result = await prisma.$transaction(async (tx) => {
        const existing = await tx.userPhoneIdentity.findUnique({ where: { userId: user.id } });
        // The number or Firebase user already signs in to ANOTHER account: refuse without saying whose.
        const clash = await tx.userPhoneIdentity.findFirst({
          where: { userId: { not: user.id }, OR: [{ phoneE164: verified.phoneE164 }, { firebaseUid: verified.uid }] },
          select: { id: true }
        });
        if (clash) throw UNAVAILABLE();
        const same = !!existing && existing.phoneE164 === verified.phoneE164 && existing.firebaseUid === verified.uid;
        const data = { firebaseUid: verified.uid, phoneE164: verified.phoneE164, linkedAt: new Date(), lastSignInAt: null, lastAuthTime: verified.authTime };
        let replaced = false;
        let oldUid: string | null = null;
        if (existing) {
          // A token that was already used to link or sign in cannot be used again.
          if (existing.lastAuthTime && existing.lastAuthTime >= verified.authTime && same) throw PHONE_TOKEN_INVALID_ERROR();
          await tx.userPhoneIdentity.update({ where: { id: existing.id }, data });
          replaced = !same;
          oldUid = same ? null : existing.firebaseUid;
        } else {
          await tx.userPhoneIdentity.create({ data: { userId: user.id, ...data } });
        }
        const ended = await endOtherSessions(tx, user.id, auth.sessionId);
        await audit(tx, {
          shopId: user.shopId,
          actorUserId: user.id,
          actorType: 'SHOP_OWNER',
          action: replaced ? 'shop.phone.replaced' : 'shop.phone.linked',
          targetType: 'user',
          targetId: user.id,
          metadata: { phone: masked, otherSessionsEnded: ended }
        });
        return { replaced, otherSessionsEnded: ended, oldUid };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw UNAVAILABLE();
      throw error;
    }
    if (result.oldUid) await verifier.revokeSessions(result.oldUid);
    ctx.loginThrottle.reset(tokenKey);
    return json({ linked: true as const, phoneMasked: masked, replaced: result.replaced, otherSessionsEnded: result.otherSessionsEnded });
  });

  app.post('/shop/account/phone/unlink', { preHandler: [guard, limits.shopMutation] }, async (request) => {
    const body = unlinkBody.parse(request.body);
    const auth = authOf(request);
    const user = await reauthenticateOwner(ctx, request, { currentPassword: body.currentPassword, firebaseIdToken: body.reauthIdToken }, 'phone_unlink');
    const outcome = await prisma.$transaction(async (tx) => {
      const identity = await tx.userPhoneIdentity.findUnique({ where: { userId: user.id } });
      if (!identity) throw new AppError(404, 'NOT_FOUND', 'No phone number is linked to this account.');
      // Never remove the last way to sign in: an account without a password needs its Google identity to remain.
      if (!user.passwordSet && !(await tx.userGoogleIdentity.findUnique({ where: { userId: user.id }, select: { id: true } }))) {
        throw new AppError(409, 'LAST_SIGNIN_METHOD', 'This is your only way to sign in, so it cannot be removed.');
      }
      await tx.userPhoneIdentity.delete({ where: { id: identity.id } });
      const ended = await endOtherSessions(tx, user.id, auth.sessionId);
      await audit(tx, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'shop.phone.unlinked', targetType: 'user', targetId: user.id, metadata: { phone: maskPhone(identity.phoneE164), otherSessionsEnded: ended } });
      return { uid: identity.firebaseUid, ended };
    });
    if (ctx.phoneVerifier) await ctx.phoneVerifier.revokeSessions(outcome.uid);
    return json({ linked: false as const, otherSessionsEnded: outcome.ended });
  });
}
