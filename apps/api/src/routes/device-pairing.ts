import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';

/** PUBLIC pairing endpoint: POST /device/pair (code -> device + one-time credential). Owner: Agent 1. */
export async function devicePairingRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // implemented in the Phase 2 feature branch that owns this file
}
