import type { FastifyReply, FastifyRequest } from 'fastify';
import { newToken, tokenHash } from '../auth.js';
import { bearerOf, COOKIE_PATH, type AppContext } from '../routes/context.js';

/** Cookie carrying the restricted onboarding grant (web). Same path/flags as the session cookie, different name. */
export const ONBOARDING_COOKIE = 'printout_onboarding';

export interface Grant {
  id: string;
  /** Which verified identity this restricted principal represents. */
  provider: 'phone' | 'google';
  firebaseUid: string;
  /** Set for provider phone. */
  phoneE164: string | null;
  /** Google-verified email (provider google). The account email at onboarding comes from here, never from the client. */
  email: string | null;
  authTime: Date;
  expiresAt: Date;
  /** Mobile only: onboarding refresh family and bound installation. */
  familyId: string | null;
  deviceId: string | null;
}

export interface IssueGrantInput {
  provider: 'phone' | 'google';
  firebaseUid: string;
  phoneE164?: string | null;
  email?: string | null;
  authTime: Date;
  /** Mobile: lifetime = the access-token TTL, bound to a refresh family and installation. Web: ONBOARDING_GRANT_TTL_MINUTES. */
  mobile?: { familyId: string; deviceId: string };
}

/**
 * The restricted principal of a verified phone that has no account yet. For web it is a cookie; for mobile the raw value IS the
 * (scoped) access token. One live grant per Firebase user; expired grants are swept here (no separate job needed).
 */
export async function issueGrant(ctx: AppContext, who: IssueGrantInput): Promise<{ raw: string; expiresAt: Date }> {
  const now = new Date();
  const raw = newToken();
  const ttlMs = who.mobile ? ctx.config.ACCESS_TOKEN_TTL_MINUTES * 60_000 : ctx.config.ONBOARDING_GRANT_TTL_MINUTES * 60_000;
  const expiresAt = new Date(now.getTime() + ttlMs);
  await ctx.prisma.phoneOnboardingGrant.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { firebaseUid: who.firebaseUid }] } });
  await ctx.prisma.phoneOnboardingGrant.create({
    data: {
      tokenHash: tokenHash(raw),
      provider: who.provider,
      firebaseUid: who.firebaseUid,
      phoneE164: who.phoneE164 ?? null,
      email: who.email ?? null,
      authTime: who.authTime,
      expiresAt,
      ...(who.mobile ? { familyId: who.mobile.familyId, deviceId: who.mobile.deviceId } : {})
    }
  });
  return { raw, expiresAt };
}

/** The grant presented by this request (bearer header first, else cookie), or null. */
export async function resolveGrant(ctx: AppContext, request: FastifyRequest): Promise<Grant | null> {
  const raw = bearerOf(request) ?? request.cookies[ONBOARDING_COOKIE];
  if (!raw || raw.length > 200) return null;
  const grant = await ctx.prisma.phoneOnboardingGrant.findFirst({ where: { tokenHash: tokenHash(raw), expiresAt: { gt: new Date() } } });
  return grant
    ? { id: grant.id, provider: grant.provider === 'google' ? 'google' : 'phone', firebaseUid: grant.firebaseUid, phoneE164: grant.phoneE164, email: grant.email, authTime: grant.authTime, expiresAt: grant.expiresAt, familyId: grant.familyId, deviceId: grant.deviceId }
    : null;
}

export function setGrantCookie(ctx: AppContext, reply: FastifyReply, raw: string, expires: Date): void {
  reply.setCookie(ONBOARDING_COOKIE, raw, { httpOnly: true, secure: ctx.config.NODE_ENV === 'production', sameSite: ctx.config.COOKIE_SAMESITE, path: COOKIE_PATH, expires });
}
