import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';

/** Device-authenticated order APIs: /device/orders (list, detail, print, reprint, download). Owner: Agent 2. */
export async function deviceOrderRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // implemented in the Phase 2 feature branch that owns this file
}
