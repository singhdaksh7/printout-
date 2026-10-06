import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';

/** Device-authenticated self APIs: /device/heartbeat, /device/push-token, /device/me. Owner: Agent 4. */
export async function deviceSelfRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // implemented in the Phase 2 feature branch that owns this file
}
