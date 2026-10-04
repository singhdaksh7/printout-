import type { FastifyInstance } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import { shopGuard, shopIdOf, authOf, type AppContext } from './context.js';

/**
 * GET /shop/events - authenticated Server-Sent Events stream, strictly scoped to the session's shop.
 * Supports Last-Event-ID replay (in-memory ring buffer), 25s heartbeats, and re-validates the session on
 * every heartbeat so logout / suspension closes the stream.
 */
export async function shopEventRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, events } = ctx;
  app.addHook('preHandler', shopGuard(ctx));

  app.get('/shop/events', async (request, reply) => {
    const shopId = shopIdOf(request);
    const { sessionId } = authOf(request);
    const header = request.headers['last-event-id'];
    const lastEventId = typeof header === 'string' && /^\d{1,20}$/.test(header) ? Number(header) : undefined;

    reply.hijack();
    // Hijacked replies skip Fastify's header flushing, so carry over CORS/security headers explicitly.
    const headers: OutgoingHttpHeaders = {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    };
    reply.raw.writeHead(200, headers);

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    unsubscribe = events.subscribe(
      shopId,
      { write: (chunk) => void reply.raw.write(chunk), close: cleanup },
      lastEventId
    );
    request.raw.on('close', cleanup);

    timer = setInterval(() => {
      void (async () => {
        try {
          const alive = await prisma.session.findFirst({
            where: {
              id: sessionId,
              invalidatedAt: null,
              expiresAt: { gt: new Date() },
              user: { shop: { status: 'ACTIVE' } }
            },
            select: { id: true }
          });
          if (!alive) return cleanup();
          if (!closed) reply.raw.write(': ping\n\n');
        } catch {
          cleanup();
        }
      })();
    }, config.SSE_HEARTBEAT_MS);
    timer.unref();
  });
}
