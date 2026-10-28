import type { Prisma } from '@prisma/client';

/**
 * A shop accepts NEW public uploads / quotes / orders when shop.status = ACTIVE AND it has either no subscription
 * row (free platform access) or a subscription with status ACTIVE. Platform billing is disabled, but admin
 * suspension or cancellation of an existing subscription is honored. Shop status SUSPENDED additionally blocks owner login/sessions.
 */
export const publicIntakeWhere: Prisma.ShopWhereInput = {
  status: 'ACTIVE',
  OR: [{ subscription: { is: null } }, { subscription: { is: { status: 'ACTIVE' } } }]
};

export const subscriptionAllowsIntake = (subscription: { status: string } | null | undefined): boolean =>
  !subscription || subscription.status === 'ACTIVE';

