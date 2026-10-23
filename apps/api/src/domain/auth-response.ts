import type { MobileCredentials } from './credentials.js';
import type { MobileAuthResponse, ProfileView, WebAuthResponse } from './profile.js';
import type { AppContext } from '../routes/context.js';

/** The single place the auth response bodies are built, so POST /auth, the exchange, refresh and onboarding can never drift apart. */
export function mobileAuthResponse(ctx: AppContext, view: ProfileView, c: MobileCredentials): MobileAuthResponse {
  const now = Date.now();
  return {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    tokenType: 'Bearer',
    expiresIn: Math.max(0, Math.round((c.accessTokenExpiresAt.getTime() - now) / 1000)),
    refreshTokenExpiresIn: Math.max(0, Math.round((c.refreshTokenExpiresAt.getTime() - now) / 1000)),
    isShopRegisteredAtLeastOne: view.isShopRegisteredAtLeastOne,
    showQr: view.showQr,
    nextStep: view.nextStep,
    user: view.user,
    shops: view.shops,
    shop: view.shop,
    onboardingAvailable: ctx.config.SHOP_SELF_ONBOARDING_ENABLED
  };
}

export function webAuthResponse(
  ctx: AppContext,
  view: ProfileView,
  parts: { session?: { expiresAt: Date }; onboarding?: { expiresAt: Date }; csrfToken?: string }
): WebAuthResponse {
  return {
    ...view,
    session: parts.session ? { transport: 'cookie', expiresAt: parts.session.expiresAt.toISOString() } : null,
    onboarding: parts.onboarding ? { transport: 'cookie', expiresAt: parts.onboarding.expiresAt.toISOString() } : null,
    ...(parts.csrfToken ? { csrfToken: parts.csrfToken } : {}),
    retentionMinutes: ctx.config.PRINT_RETENTION_MINUTES,
    onboardingAvailable: ctx.config.SHOP_SELF_ONBOARDING_ENABLED
  };
}
