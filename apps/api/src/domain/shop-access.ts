import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface OwnedShop {
  id: string;
  slug: string;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PILOT' | 'PAST_DUE' | 'CANCELLED';
  acceptsOrders: boolean;
  createdAt: Date;
  isDefault: boolean;
}

/**
 * Shops an owner may act on: the legacy default shop (User.shopId) plus every Membership with role OWNER.
 * Authorization is derived from the database for the authenticated user only; nothing here trusts a client-supplied id.
 */
export async function listOwnedShops(db: Db, userId: string): Promise<OwnedShop[]> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      shopId: true,
      memberships: { where: { role: 'OWNER' }, select: { shopId: true } }
    }
  });
  if (!user || user.role !== 'SHOP_OWNER') return [];
  const ids = new Set<string>(user.memberships.map((m) => m.shopId));
  if (user.shopId) ids.add(user.shopId);
  if (ids.size === 0) return [];
  const shops = await db.shop.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, slug: true, displayName: true, status: true, acceptsOrders: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });
  return shops.map((s) => ({ ...s, isDefault: s.id === user.shopId }));
}

/**
 * The single authorization check for any `/shops/{shopId}/...` route: returns the shop only when the caller owns it.
 * A shop the caller does not own is indistinguishable from a missing one (404), so ids cannot be probed across tenants.
 */
export async function requireOwnedShop(db: Db, userId: string, shopId: string): Promise<OwnedShop> {
  const owned = await listOwnedShops(db, userId);
  const shop = owned.find((s) => s.id === shopId);
  if (!shop) throw new AppError(404, 'NOT_FOUND', 'Shop not found');
  return shop;
}
