import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';

/** Shop-owner device management: /shop/devices (list, pairing-codes, rename, revoke). Owner: Agent 1. */
export async function shopDeviceRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // implemented in the Phase 2 feature branch that owns this file
}
