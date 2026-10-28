import type { Prisma, PrismaClient } from '@prisma/client';
import { publicAvailability } from './hours-view.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** URL (relative to the API base) that serves a shop photo to an authenticated customer. Photos are private objects; this is never a storage URL. */
export const customerImagePath = (shopId: string, imageId: string) => `/customer/shops/${shopId}/images/${imageId}`;

export const SUPPORTED_PAPER_TYPES = ['normal'] as const;

export interface RateView {
  paperSize: string;
  colourMode: 'bw' | 'colour';
  sides: 'single' | 'duplex';
  /** Per SHEET (a duplex sheet carries two pages). The authoritative price is always recalculated by the server at quote/order time. */
  pricePerSheetPaise: number;
}

/**
 * The customer-facing card for shops that discovery already authorised (verified + ACTIVE). Never includes owner identity, email, login
 * phone, devices, subscription or audit data. `isOpen` combines the owner's switch with the server-evaluated hours.
 */
export async function shopCards(db: Db, ids: string[], opts: { includeLocation?: boolean; now?: Date } = {}) {
  if (ids.length === 0) return new Map<string, ReturnType<typeof toCard>>();
  const shops = await db.shop.findMany({
    where: { id: { in: ids } },
    include: {
      settings: true,
      pricingRules: { where: { active: true }, orderBy: [{ paperSize: 'asc' }, { colourMode: 'asc' }, { sides: 'asc' }] },
      paperOptions: { orderBy: [{ kind: 'asc' }, { value: 'asc' }] },
      images: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
    }
  });
  return new Map(shops.map((s) => [s.id, toCard(s, opts)]));
}

type CardShop = Prisma.ShopGetPayload<{ include: { settings: true; pricingRules: true; paperOptions: true; images: true } }>;

function toCard(s: CardShop, opts: { includeLocation?: boolean; now?: Date }) {
  const availability = publicAvailability(s.settings, opts.now);
  const paperSizes = s.paperOptions.filter((o) => o.kind === 'paperSize').map((o) => o.value);
  const paperTypes = s.paperOptions.filter((o) => o.kind === 'paperType').map((o) => o.value);
  const rates: RateView[] = s.pricingRules.map((r) => ({ paperSize: r.paperSize, colourMode: r.colourMode, sides: r.sides, pricePerSheetPaise: r.pricePerSheetPaise }));
  return {
    id: s.id,
    shopName: s.displayName,
    phoneNumber: s.settings?.publicContact ?? null,
    addressLine1: s.address,
    addressLine2: s.addressLine2,
    city: s.city,
    state: s.state,
    pincode: s.pincode,
    ...(opts.includeLocation && s.latitude !== null && s.longitude !== null ? { location: { latitude: s.latitude, longitude: s.longitude } } : {}),
    /** Owner switch AND currently open by hours (unknown hours do not close a shop). */
    isOpen: s.acceptsOrders && availability.state !== 'closed',
    acceptsOrders: s.acceptsOrders,
    availability: { state: availability.state, reason: availability.reason, nextOpenAt: availability.nextOpenAt, closesAt: availability.closesAt, orderingBlocked: availability.orderingBlocked },
    rates,
    paperSizes,
    /** Plain paper is the only type priced today; configured types are listed as stored. */
    paperTypes: paperTypes.length > 0 ? paperTypes : [...SUPPORTED_PAPER_TYPES],
    images: s.images.map((i) => ({ id: i.id, url: customerImagePath(s.id, i.id), sortOrder: i.sortOrder })),
    /** cash is always possible unless the owner removed it; upiId is shown only when UPI is accepted. */
    acceptedPaymentMethods: s.acceptedPaymentMethods.map((m) => (m === 'CASH' ? 'cash' : 'upi')),
    upiId: s.acceptedPaymentMethods.includes('UPI') ? s.upiId : null,
    ratingAvg: null as number | null,
    ratingCount: 0
  };
}

export type ShopCard = ReturnType<typeof toCard>;
