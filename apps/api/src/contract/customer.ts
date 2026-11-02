import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../routes/context.js';

// PDF contract routes for everyone/customers: /me, /me/fcm-token, /shops/nearby, shop detail + reviews, /uploads/presign,
// /orders*, /reviews. See contract/facade.ts for how the contract is selected and how errors are shaped.
export async function pdfCustomerRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // implemented per endpoint
}
