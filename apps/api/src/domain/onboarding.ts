/**
 * Server-derived onboarding state shared by Web and Mobile. QR readiness is a READINESS check, never an authentication
 * factor: the QR is virtual (`<WEB_ORIGIN>/p/<slug>`, the same URL GET /shop/qr returns) and is never persisted, so there is
 * nothing to "generate" beyond the shop being live. Pure functions: no I/O.
 */
export type NextStep = 'dashboard' | 'complete_profile' | 'create_shop' | 'generate_qr' | 'account_blocked';

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type QrReason = 'shop_pending_activation' | 'shop_suspended' | 'shop_inactive' | 'invalid_slug';

export interface QrReadiness {
  ready: boolean;
  /** The public upload URL encoded in the QR; null while the shop is not ready (nothing should be printed yet). */
  publicUrl: string | null;
  reason: QrReason | null;
}

export type ShopStatusName = 'ACTIVE' | 'SUSPENDED' | 'PILOT' | 'PAST_DUE' | 'CANCELLED';

export const publicShopUrl = (webOrigin: string, slug: string): string => `${webOrigin.replace(/\/$/, '')}/p/${slug}`;

function validHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** A QR destination is usable only for a live (ACTIVE) shop with a well-formed slug; the public page serves ACTIVE shops only. */
export function qrReadiness(shop: { slug: string; status: ShopStatusName }, webOrigin: string): QrReadiness {
  if (shop.status === 'SUSPENDED') return { ready: false, publicUrl: null, reason: 'shop_suspended' };
  if (shop.status === 'PILOT') return { ready: false, publicUrl: null, reason: 'shop_pending_activation' };
  if (shop.status !== 'ACTIVE') return { ready: false, publicUrl: null, reason: 'shop_inactive' };
  const url = publicShopUrl(webOrigin, shop.slug);
  if (!SLUG_PATTERN.test(shop.slug) || !validHttpUrl(url)) return { ready: false, publicUrl: null, reason: 'invalid_slug' };
  return { ready: true, publicUrl: url, reason: null };
}

export interface NextStepInput {
  /** null = a verified phone identity that has no local account yet. */
  role: 'SHOP_OWNER' | 'PLATFORM_ADMIN' | null;
  displayName: string | null;
  shop: { status: ShopStatusName; slug: string; address: string | null } | null;
}

export function deriveNextStep(input: NextStepInput, webOrigin: string): NextStep {
  if (input.role === 'PLATFORM_ADMIN') return 'dashboard';
  if (!input.shop) return 'create_shop';
  if (input.shop.status === 'SUSPENDED') return 'account_blocked';
  if (!input.displayName?.trim() || !input.shop.address?.trim()) return 'complete_profile';
  if (!qrReadiness(input.shop, webOrigin).ready) return 'generate_qr';
  return 'dashboard';
}
