import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../routes/context.js';

// PDF contract routes for shop owners and admins: /shops/mine, PATCH /shops/{id}, rates, paper-options, images, shop orders,
// order status/payment, /admin/shops*. See contract/facade.ts for how the contract is selected and how errors are shaped.
export async function pdfOwnerAdminRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // implemented per endpoint
}
