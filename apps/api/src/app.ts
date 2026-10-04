import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { LoginThrottle } from './auth.js';
import { loadConfig, type Config } from './config.js';
import { AppError, registerErrorHandlers } from './errors.js';
import { ShopEvents } from './events.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { json, type AppContext } from './routes/context.js';
import { publicRoutes } from './routes/public.js';
import { shopConfigRoutes } from './routes/shop-config.js';
import { shopEventRoutes } from './routes/shop-events.js';
import { shopOrderRoutes } from './routes/shop-orders.js';
import { internalStorageRoutes } from './internal-storage.js';
import { createStorage, type Storage } from './storage/index.js';
import { uploadRoutes } from './uploads.js';

export interface AppDeps {
  config?: Config;
  prisma?: PrismaClient;
  storage?: Storage;
  events?: ShopEvents;
  /** Test hook: destination for the request logger. */
  logStream?: NodeJS.WritableStream;
}

/** URL for logs: no query string, and bearer-token path segments replaced. */
export function safeRequestUrl(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path
    .replace(/^(\/api\/v1\/public\/orders\/)[^/]+/, '$1:token')
    .replace(/^(\/api\/v1\/internal\/documents\/)[^/]+/, '$1:key');
}

export function createApp(deps: AppDeps = {}) {
  const config = deps.config ?? loadConfig();
  const prisma = deps.prisma ?? new PrismaClient();
  const storage = deps.storage ?? createStorage(config);
  const events = deps.events ?? new ShopEvents();
  const loginThrottle = new LoginThrottle(config.LOGIN_FAIL_MAX, config.LOGIN_FAIL_WINDOW_MINUTES * 60_000);
  const ctx: AppContext = { config, prisma, storage, events, loginThrottle };

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
      serializers: {
        // Default serializer logs the full URL: query strings carry signed-URL signatures and upload tokens, and
        // some paths carry bearer tokens (tracking token, storage key).
        req: (request: { method?: string; url?: string; host?: string; ip?: string; socket?: { remotePort?: number } }) => ({
          method: request.method,
          url: safeRequestUrl(request.url ?? ''),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort
        })
      },
      ...(deps.logStream ? { stream: deps.logStream } : {})
    },
    trustProxy: config.TRUST_PROXY_CIDRS ?? config.TRUST_PROXY,
    bodyLimit: config.JSON_BODY_LIMIT_BYTES,
    // Node's default is "no timeout" under Fastify; bound slow-body (slowloris-style) requests. Matches the upload token TTL.
    requestTimeout: 15 * 60_000,
    genReqId: () => randomUUID()
  });

  registerErrorHandlers(app);
  // API responses carry tokens, document URLs and order data: never cacheable unless a route says otherwise.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.register(helmet);
  app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'last-event-id']
  });
  app.register(cookie);
  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down and retry shortly.')
  });

  app.addHook('preClose', async () => {
    events.closeAll();
  });

  app.get('/health', async () => json({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return reply.code(503).send({ error: { code: 'INTERNAL_ERROR', message: 'Database unavailable', requestId: _request.id } });
    }
    return json({ status: 'ready' });
  });

  app.register(
    async (api) => {
      await api.register((i) => authRoutes(i, ctx));
      await api.register((i) => publicRoutes(i, ctx));
      await api.register((i) => shopOrderRoutes(i, ctx));
      await api.register((i) => shopConfigRoutes(i, ctx));
      await api.register((i) => shopEventRoutes(i, ctx));
      await api.register((i) => adminRoutes(i, ctx));
    },
    { prefix: '/api/v1' }
  );

  // Upload pipeline + local signed-URL file routes (owned by FILES).
  app.register(uploadRoutes, { prefix: '/api/v1', prisma, storage, config });
  app.register(internalStorageRoutes, { prefix: '/api/v1', prisma, storage, config });

  return { app, prisma, storage, events, config };
}
