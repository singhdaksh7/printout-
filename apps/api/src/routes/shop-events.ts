import type { FastifyInstance } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import { AppError } from '../errors.js';
import { NOTIFICATION_EVENT, type NotificationDto } from '../notifications/shop-notifications.js';
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
 * - Durable notifications (`notification.created`, see notifications/shop-notifications.ts) are pushed on the same stream
 *   WITHOUT an SSE `id` (so they never disturb Last-Event-ID); replay after a gap is the cursor list GET /shop/notifications.
 *   Session validity is re-checked before every notification is written, and slow consumers are disconnected rather than
 *   buffered (bounded memory); they reconnect and reconcile from the database.
 */
export async function shopEventRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config, events, notifications } = ctx;
  /** Open streams per login session (a session = one browser login; each tab opens one stream). */
  const perSession = new Map<string, number>();
  const MAX_PENDING_NOTIFICATIONS = 100;
  const MAX_WRITE_BACKLOG_BYTES = 256 * 1024;
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
    if ((perSession.get(sessionId) ?? 0) >= config.SSE_MAX_CONNECTIONS_PER_SESSION) {
      reply.header('retry-after', '5');
      throw new AppError(429, 'RATE_LIMITED', 'Too many open event streams for this session. Close other tabs and retry shortly.');
    }
    perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + 1);

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

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeNotifications: () => void = () => undefined;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      unsubscribe();
      unsubscribeNotifications();
      const left = (perSession.get(sessionId) ?? 1) - 1;
      if (left <= 0) perSession.delete(sessionId);
      else perSession.set(sessionId, left);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    // Any way the connection can end frees the slot (registered before the first await so an early abort is caught).
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    const sessionAlive = async (): Promise<boolean> => {
      const alive = await prisma.session.findFirst({
        where: { id: sessionId, invalidatedAt: null, expiresAt: { gt: new Date() }, user: { shop: { status: 'ACTIVE' } } },
        select: { id: true }
      });
      return alive !== null;
    };

    // Notifications are written one at a time (ordered), re-authorised first, and bounded: a consumer that cannot keep up
    // is dropped (it reconnects and reconciles from the database) instead of growing server memory.
    let pending = 0;
    let chain: Promise<void> = Promise.resolve();
    const deliverNotifications = (items: NotificationDto[]) => {
      if (closed) return;
      if (pending >= MAX_PENDING_NOTIFICATIONS) return cleanup();
      pending += 1;
      chain = chain.then(async () => {
        try {
          if (closed) return;
          if (!(await sessionAlive())) return cleanup();
          if (reply.raw.writableLength > MAX_WRITE_BACKLOG_BYTES) return cleanup();
          for (const item of items) reply.raw.write(`event: ${NOTIFICATION_EVENT}\ndata: ${JSON.stringify(item)}\n\n`);
        } catch {
          cleanup();
        } finally {
          pending -= 1;
        }
      });
    };

    try {
      // Registered before the headers go out so the poller baseline is set before the client can react to `open`.
      unsubscribeNotifications = await notifications.subscribe(shopId, { deliver: deliverNotifications });
    } catch {
      return cleanup();
    }
    if (closed) return cleanup();

    reply.raw.writeHead(200, headers);
    unsubscribe = events.subscribe(
      shopId,
      { write: (chunk) => void reply.raw.write(chunk), close: cleanup },
      lastEventId
    );

    timer = setInterval(() => {
      void (async () => {
        try {
          if (!(await sessionAlive())) return cleanup();
          if (!closed) reply.raw.write(': ping\n\n');
        } catch {
          cleanup();
        }
      })();
    }, config.SSE_HEARTBEAT_MS);
    timer.unref();
  });
}
