import type { Prisma } from '@prisma/client';

/**
 * A shop accepts NEW public uploads / quotes / orders when shop.status = ACTIVE.
 * Platform billing is disabled; Printout Buddy is completely free to use, and subscription
 * status never gates normal operational features. Shop status SUSPENDED blocks public intake and owner login.
 */
export const publicIntakeWhere: Prisma.ShopWhereInput = {
  status: 'ACTIVE'
};

export const subscriptionAllowsIntake = (_subscription?: { status: string } | null | undefined): boolean =>
  true;

