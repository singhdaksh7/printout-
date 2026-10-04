import type { FastifyInstance } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import { AppError } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { shopGuard, shopIdOf, authOf, type AppContext } from './context.js';

/**
 * GET /shop/events - authenticated Server-Sent Events stream, strictly scoped to the session's shop.
 *
 * Production notes:
 * - ONE realtime-producing API instance: the bus (events.ts) is in memory, so events emitted by another process or
 *   replica never reach these streams (the retention worker is a separate process and cannot push either). Scaling the
 *   API horizontally requires replacing the bus (e.g. Postgres LISTEN/NOTIFY) first.
 * - Auth/tenant: shopGuard runs on connect (session, SHOP_OWNER role, shop ACTIVE); the session is re-validated on
 *   every heartbeat so logout / suspension closes the stream within one interval.
 * - Limits: SSE_MAX_CONNECTIONS_PER_SHOP concurrent streams per shop (slot freed on close/error/abort) and
 *   RATE_LIMIT_SSE_CONNECT_MAX connects per minute per session, so reconnect loops cannot hammer the API.
 * - Proxy friendliness: heartbeat comment every SSE_HEARTBEAT_MS (<= 25s, below typical 60s idle timeouts),
 *   `X-Accel-Buffering: no`, no-transform. Node's requestTimeout only bounds receiving the request (a GET is complete
 *   immediately) and keepAliveTimeout only applies between requests, so neither terminates an open stream
 *   (covered by a real-socket test); the hijacked response is also exempt from Fastify's connectionTimeout (0).
 * - Supports Last-Event-ID replay from a per-shop in-memory ring buffer.
 */
export async function shopEventRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, events } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  app.addHook('preHandler', shopGuard(ctx));

  app.get('/shop/events', { preHandler: limits.sseConnect }, async (request, reply) => {
    const shopId = shopIdOf(request);
    const { sessionId } = authOf(request);
    const header = request.headers['last-event-id'];
    const lastEventId = typeof header === 'string' && /^\d{1,20}$/.test(header) ? Number(header) : undefined;

    if (events.connectionCount(shopId) >= config.SSE_MAX_CONNECTIONS_PER_SHOP) {
      reply.header('retry-after', '5');
      throw new AppError(429, 'RATE_LIMITED', 'Too many open event streams for this shop. Close other tabs and retry shortly.');
    }

    reply.hijack();
    // Hijacked replies skip Fastify's header flushing and onSend hooks, so carry over CORS/security headers explicitly.
    const headers: OutgoingHttpHeaders = {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    };
    // Detect dead peers (no FIN) via TCP keepalive; the stream itself must never hit an idle socket timeout.
    request.raw.socket.setKeepAlive(true, 30_000);
    request.raw.socket.setTimeout(0);
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
    // Any way the connection can end frees the slot.
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

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
