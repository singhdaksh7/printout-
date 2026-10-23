import type { PrismaClient } from '@prisma/client';
import { deriveNextStep, qrReadiness, type NextStep, type ShopStatusName } from './onboarding.js';

/**
 * The shared profile contract for Web and Mobile (POST /auth, POST /auth/firebase/exchange, POST /auth/refresh, GET /users/me,
 * GET /shops/me, POST /shops/onboarding). Everything is DERIVED from existing tables; nothing is stored twice and nothing is
 * invented. `null` always means "not available / not modelled", never "unknown but present". Never contains firebaseUid, FCM
 * tokens, password data or anything about another tenant.
 *
 * Data model note: a user belongs to exactly ONE shop (User.shopId). The Membership table exists but no business logic uses it, so it
 * is NOT treated as authorization: `shops` always has zero or one element (the default shop).
 */
export type ApiRole = 'shop' | 'admin' | null;

export interface UserProfile {
  /** null only for a verified phone that has no account yet (restricted onboarding identity). */
  id: string | null;
  /** shop = SHOP_OWNER, admin = PLATFORM_ADMIN, null = no account yet. There is no persistent customer role. */
  role: ApiRole;
  name: string | null;
  email: string | null;
  /** E.164 of the caller's OWN linked (or just-verified) phone, else null. */
  phoneNumber: string | null;
  /** email = a real password exists; otp = a Firebase phone identity is linked; google = a Firebase Google identity is linked (or the restricted identity just proved it). */
  loginMethods: Array<'email' | 'otp' | 'google'>;
  /** true ONLY when a linked Google identity's verified email equals this account's email; there is no other email verification flow. */
  emailVerified: boolean;
  /** True iff a Firebase-verified phone identity is linked (or the restricted identity just proved the number). */
  phoneVerified: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastLoginAt: string | null;
}

export interface RateInfo {
  paperSize: string;
  colourMode: string;
  sides: string;
  pricePerSheetPaise: number;
}

export interface ShopProfile {
  id: string;
  /** The SHOP_OWNER user of this shop; null if the shop has no owner row. */
  ownerId: string | null;
  shopName: string;
  /** ShopSettings.publicContact (the number customers see), else null. Not the owner's login phone. */
  phoneNumber: string | null;
  address: string | null;
  /** Extra: 6-digit PIN; null for shops created before it was collected. */
  pincode: string | null;
  /** Not modelled: always null. */
  location: null;
  /** premium only for an ACTIVE subscription to the plan with key "premium"; otherwise standard. */
  status: 'standard' | 'premium';
  /** From the shop's subscription; null when none (e.g. self-onboarded PILOT shops). `key` can be null for legacy plans. */
  plan: { key: string | null; name: string } | null;
  /** No admin-verification concept exists: always null (never fabricated). */
  isVerified: null;
  /** shop.status === 'ACTIVE' (fully live). PILOT, SUSPENDED, PAST_DUE and CANCELLED are false. */
  isActive: boolean;
  /** Per-shop QR readiness (live shop with a well-formed slug). */
  showQr: boolean;
  /** The actual public upload URL (WEB_ORIGIN/p/<slug>) when showQr is true, else null. Virtual: derived, never stored. */
  qrCodeUrl: string | null;
  /** Active pricing rules; empty array when none configured. */
  rateInfo: RateInfo[];
  /** Derived from rateInfo. */
  services: { colourModes: string[]; sides: string[] };
  /** Not available (payments are not enabled): always null. */
  payment: null;
  /** Not modelled: always null. */
  rating: null;
  createdAt: string;
  updatedAt: string;
  // ---- extras ----
  slug: string;
  /** Raw ShopStatus (ACTIVE, SUSPENDED, PILOT, PAST_DUE, CANCELLED). */
  shopStatus: ShopStatusName;
  acceptsOrders: boolean;
  /** true for the default shop (shops[0]); showQr/nextStep at the top level refer to it. */
  isDefault: boolean;
  /** self = created by phone self-onboarding, admin = created by a platform admin, null = unknown (legacy/seed). */
  registeredBy: 'self' | 'admin' | null;
  /** Not modelled: always null. */
  images: null;
  /** Not modelled; referral awards do not exist: always null. */
  referral: null;
  onboardingStatus: NextStep;
}

export interface QrInfo {
  ready: boolean;
  publicUrl: string | null;
  /** Same as publicUrl. */
  qrCodeUrl: string | null;
  reason: 'shop_pending_activation' | 'shop_suspended' | 'shop_inactive' | 'invalid_slug' | null;
}

/** What GET /users/me returns (and the profile part of every auth response). */
export interface ProfileView {
  user: UserProfile;
  /** Shops the user is authorized for: zero or one element (single-shop data model); shops[0] is the default. */
  shops: ShopProfile[];
  /** Same object as shops[0], or null. Kept for compatibility. */
  shop: ShopProfile | null;
  /** Derived from the DEFAULT shop. */
  nextStep: NextStep;
  /** shops.length > 0, computed server-side. */
  isShopRegisteredAtLeastOne: boolean;
  /** Default shop's showQr; false when there is no shop. */
  showQr: boolean;
}

/**
 * Mobile auth response (POST /auth, POST /auth/firebase/exchange with client:'mobile', POST /auth/refresh, POST /shops/onboarding with
 * client:'mobile'). Both tokens are ALWAYS present for an authorized identity, including a restricted onboarding identity (verified phone,
 * no account yet: user.id is null, nextStep create_shop, accessToken scoped to POST /shops/onboarding, GET /users/me and logout).
 * Never mix with the Firebase ID token, Firebase's own refresh token (never seen by this API) or the FCM token. Never log any token.
 */
export interface MobileAuthResponse extends ProfileView {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Seconds until the access token expires (ACCESS_TOKEN_TTL_MINUTES * 60). */
  expiresIn: number;
  /** Seconds until the refresh token expires (REFRESH_TOKEN_TTL_DAYS * 86400). */
  refreshTokenExpiresIn: number;
  /** Whether POST /shops/onboarding is enabled on this server. */
  onboardingAvailable: boolean;
}

/** Web auth response (cookies carry the credentials; nothing secret in the body except the CSRF token). */
export interface WebAuthResponse extends ProfileView {
  session: { transport: 'cookie'; expiresAt: string } | null;
  /** Restricted onboarding grant cookie (create_shop); present instead of `session` when the phone has no account yet. */
  onboarding: { transport: 'cookie'; expiresAt: string } | null;
  csrfToken?: string;
  retentionMinutes: number;
  onboardingAvailable: boolean;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The profile of a verified identity that has no account yet (restricted onboarding principal). */
export function restrictedProfile(subject: { provider: 'phone' | 'google'; phone?: string | null; email?: string | null } | string): ProfileView {
  const s = typeof subject === 'string' ? { provider: 'phone' as const, phone: subject, email: null } : subject;
  const google = s.provider === 'google';
  return {
    user: {
      id: null,
      role: null,
      name: null,
      email: google ? (s.email ?? null) : null,
      phoneNumber: google ? null : (s.phone ?? null),
      loginMethods: [google ? 'google' : 'otp'],
      emailVerified: google,
      phoneVerified: !google,
      createdAt: null,
      updatedAt: null,
      lastLoginAt: null
    },
    shops: [],
    shop: null,
    nextStep: 'create_shop',
    isShopRegisteredAtLeastOne: false,
    showQr: false
  };
}

export async function loadProfile(prisma: PrismaClient, webOrigin: string, userId: string): Promise<ProfileView> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      phoneIdentity: { select: { phoneE164: true } },
      googleIdentity: { select: { email: true } },
      shop: {
        include: {
          settings: { select: { publicContact: true } },
          subscription: { include: { plan: true } },
          pricingRules: { where: { active: true }, orderBy: [{ paperSize: 'asc' }, { colourMode: 'asc' }, { sides: 'asc' }] }
        }
      }
    }
  });
  const nextStep = deriveNextStep(
    { role: user.role, displayName: user.displayName, shop: user.shop ? { status: user.shop.status, slug: user.shop.slug, address: user.shop.address } : null },
    webOrigin
  );
  const profile: UserProfile = {
    id: user.id,
    role: user.role === 'PLATFORM_ADMIN' ? 'admin' : 'shop',
    name: user.displayName,
    email: user.email,
    phoneNumber: user.phoneIdentity?.phoneE164 ?? null,
    loginMethods: [...(user.passwordSet ? (['email'] as const) : []), ...(user.phoneIdentity ? (['otp'] as const) : []), ...(user.googleIdentity ? (['google'] as const) : [])],
    emailVerified: !!user.googleIdentity && user.googleIdentity.email.toLowerCase() === user.email.toLowerCase(),
    phoneVerified: !!user.phoneIdentity,
    createdAt: iso(user.createdAt),
    updatedAt: iso(user.updatedAt),
    lastLoginAt: iso(user.lastLoginAt)
  };
  if (!user.shop) return { user: profile, shops: [], shop: null, nextStep, isShopRegisteredAtLeastOne: false, showQr: false };

  const shop = user.shop;
  const qr = qrReadiness(shop, webOrigin);
  const [created, owner] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { targetType: 'shop', targetId: shop.id, action: { in: ['admin.shop.create', 'shop.onboarding.created'] } },
      orderBy: { createdAt: 'asc' },
      select: { action: true }
    }),
    prisma.user.findFirst({ where: { shopId: shop.id, role: 'SHOP_OWNER' }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  ]);
  const rateInfo: RateInfo[] = shop.pricingRules.map((r) => ({ paperSize: r.paperSize, colourMode: r.colourMode, sides: r.sides, pricePerSheetPaise: r.pricePerSheetPaise }));
  const plan = shop.subscription?.plan ?? null;
  const shopProfile: ShopProfile = {
    id: shop.id,
    ownerId: owner?.id ?? null,
    shopName: shop.displayName,
    phoneNumber: shop.settings?.publicContact ?? null,
    address: shop.address,
    pincode: shop.pincode,
    location: null,
    status: plan?.key === 'premium' && shop.subscription?.status === 'ACTIVE' ? 'premium' : 'standard',
    plan: plan ? { key: plan.key, name: plan.name } : null,
    isVerified: null,
    isActive: shop.status === 'ACTIVE',
    showQr: qr.ready,
    qrCodeUrl: qr.publicUrl,
    rateInfo,
    services: { colourModes: [...new Set(rateInfo.map((r) => r.colourMode))], sides: [...new Set(rateInfo.map((r) => r.sides))] },
    payment: null,
    rating: null,
    createdAt: shop.createdAt.toISOString(),
    updatedAt: shop.updatedAt.toISOString(),
    slug: shop.slug,
    shopStatus: shop.status,
    acceptsOrders: shop.acceptsOrders,
    isDefault: true,
    registeredBy: created?.action === 'admin.shop.create' ? 'admin' : created?.action === 'shop.onboarding.created' ? 'self' : null,
    images: null,
    referral: null,
    onboardingStatus: nextStep
  };
  return { user: profile, shops: [shopProfile], shop: shopProfile, nextStep, isShopRegisteredAtLeastOne: true, showQr: qr.ready };
}
