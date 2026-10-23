import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { burnPasswordCheck, verifyPassword } from '../auth.js';
import { accountBlocked } from '../domain/credentials.js';
import { AppError } from '../errors.js';
import { fcmKey, registerToken } from '../notifications/fcm-registrations.js';
import { authResponseFor, deviceIdSchema, firebaseSignIn, type FirebaseSignInResult } from './auth-firebase.js';
import { googleSignIn } from './auth-google.js';
import { audit, json, type AppContext } from './context.js';

const authBody = z
  .object({
    loginMethod: z.enum(['otp', 'email', 'google']),
    /** otp only: optional claim that MUST equal the verified number (it never authorizes by itself). */
    phoneNumber: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional(),
    firebaseIdToken: z.string().min(20).max(4096).optional(),
    email: z.string().trim().max(254).email().transform((v) => v.toLowerCase()).optional(),
    password: z.string().min(1).max(256).optional(),
    /** Registered ONLY after authentication succeeds; a push failure never fails the sign-in. */
    fcmToken: z.string().min(20).max(4096).regex(/^\S+$/).optional().catch(undefined),
    installationId: deviceIdSchema,
    platform: z.enum(['android', 'ios', 'web'])
  })
  .strict()
  .superRefine((b, c) => {
    if ((b.loginMethod === 'otp' || b.loginMethod === 'google') && !b.firebaseIdToken) c.addIssue({ code: 'custom', path: ['firebaseIdToken'], message: `firebaseIdToken is required for loginMethod ${b.loginMethod}` });
    if (b.loginMethod === 'email' && (!b.email || !b.password)) c.addIssue({ code: 'custom', path: [b.email ? 'password' : 'email'], message: 'email and password are required for loginMethod email' });
  });

/**
 * POST /auth, the unified mobile sign-in (Bearer access token + rotating refresh token, flat in the response). Three methods, one
 * response contract (domain/auth-response.ts):
 *   otp    Firebase phone ID token (the number alone never authorizes);
 *   google Firebase Google ID token (resolution only by Firebase uid, never by matching an email);
 *   email  email + password through the SAME throttles and argon2 check as /auth/login. Platform admins are refused here (Admin 2FA untouched).
 */
export async function authMobileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;

  async function emailSignIn(request: FastifyRequest, reply: FastifyReply, email: string, password: string, deviceId: string): Promise<FirebaseSignInResult> {
    const throttleKey = `${request.ip}|${email}`;
    const accountKey = `acct|${email}`;
    // Same budgets as /auth/login: a failure here counts there and vice versa (rotating IPs cannot buy extra guesses).
    if (ctx.loginThrottle.isBlocked(throttleKey) || ctx.loginThrottle.isBlocked(accountKey, Date.now(), config.LOGIN_FAIL_MAX * 4)) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.');
    }
    const user = await prisma.user.findUnique({ where: { email }, include: { shop: true } });
    // Unknown accounts still pay for one password verification so timing does not reveal existence.
    const valid = user ? await verifyPassword(user.passwordHash, password) : await burnPasswordCheck(password);
    if (!user || !valid) {
      ctx.loginThrottle.recordFailure(throttleKey);
      ctx.loginThrottle.recordFailure(accountKey);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    // A platform admin must use the admin console (password + Admin 2FA); never a mobile session.
    if (user.role !== 'SHOP_OWNER') throw new AppError(403, 'FORBIDDEN', 'This account cannot sign in here. Use the admin console.');
    if (user.shop?.status === 'SUSPENDED') throw accountBlocked();
    ctx.loginThrottle.reset(throttleKey);
    ctx.loginThrottle.reset(accountKey);
    const response = await authResponseFor(ctx, request, reply, user.id, 'mobile', deviceId);
    await audit(prisma, { shopId: user.shopId, actorUserId: user.id, actorType: 'SHOP_OWNER', action: 'auth.login', targetType: 'user', targetId: user.id, metadata: { method: 'email', client: 'mobile' } });
    return { response, principal: { userId: user.id, shopId: user.shopId } };
  }

  app.post('/auth', { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = authBody.parse(request.body);
    let result: FirebaseSignInResult;
    if (body.loginMethod === 'otp') {
      result = await firebaseSignIn(ctx, request, reply, { idToken: body.firebaseIdToken!, client: 'mobile', deviceId: body.installationId, phoneNumber: body.phoneNumber, auditAction: 'auth.login' });
    } else if (body.loginMethod === 'google') {
      result = await googleSignIn(ctx, request, reply, { idToken: body.firebaseIdToken!, deviceId: body.installationId, auditAction: 'auth.login' });
    } else {
      result = await emailSignIn(request, reply, body.email!, body.password!, body.installationId);
    }
    // Push registration happens only AFTER authentication, bound to this user + installation (shopId from the server); failures never fail login.
    if (body.fcmToken && result.principal) {
      try {
        await registerToken(prisma, fcmKey(config), { userId: result.principal.userId, shopId: result.principal.shopId, installationId: body.installationId, platform: body.platform, token: body.fcmToken });
        await audit(prisma, { shopId: result.principal.shopId, actorUserId: result.principal.userId, actorType: 'SHOP_OWNER', action: 'user.fcm_token.registered', targetType: 'user', targetId: result.principal.userId, metadata: { platform: body.platform, via: 'auth' } });
      } catch {
        /* a push failure must never fail the sign-in */
      }
    }
    return json(result.response);
  });
}
