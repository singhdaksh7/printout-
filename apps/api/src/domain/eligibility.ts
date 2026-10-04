import type { Prisma } from '@prisma/client';

/**
 * A shop accepts NEW public uploads / quotes / orders only when shop.status = ACTIVE AND it has either no subscription
 * row (not yet billed) or a subscription with status ACTIVE. SUSPENDED/CANCELLED subscriptions therefore stop new public
 * intake WITHOUT locking out the owner: login, reads and handling of existing orders keep working, and the retention
 * worker deletes documents on schedule regardless. Shop status SUSPENDED additionally blocks owner login/sessions.
 */
export const publicIntakeWhere: Prisma.ShopWhereInput = {
  status: 'ACTIVE',
  OR: [{ subscription: { is: null } }, { subscription: { is: { status: 'ACTIVE' } } }]
};

export const subscriptionAllowsIntake = (subscription: { status: string } | null | undefined): boolean =>
  !subscription || subscription.status === 'ACTIVE';
