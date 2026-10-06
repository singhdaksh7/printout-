import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { AppError } from './errors.js';

/**
 * Rate limits for the authenticated shop/admin surfaces (public routes keep their own per-IP route limits).
 *
 * - Bucket key is the SESSION id once the guard has authenticated the request, so several staff behind one shared
 *   NAT do not throttle each other; it falls back to the client IP (as resolved by trustProxy) otherwise.
 * - Limiters are plain preHandlers built on @fastify/rate-limit's `createRateLimit`, created once per category and
 *   shared by every route in that category (one bucket per session per category).
 * - They must run AFTER the auth guard (route-level `preHandler` runs after instance-level hooks).
 * - Counters are in memory, per API process (the API runs as a single instance; see SECURITY_REVIEW).
 */
export type Limiter = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface Limiters {
  shopRead: Limiter;
  status: Limiter;
  printConfirm: Limiter;
  documentAccess: Limiter;
  shopMutation: Limiter;
  adminRead: Limiter;
  adminMutation: Limiter;
  sseConnect: Limiter;
  /** Device surface: bucket per authenticated device (falls back to IP before the guard has run). */
  deviceRead: Limiter;
  deviceMutation: Limiter;
  /** Unauthenticated pairing: strictly per client IP. */
  devicePair: Limiter;
  /** Coarse per-IP ceiling for a whole scope (also covers unauthenticated floods that never reach a session). */
  ipCeiling: (max: number) => Limiter;
}

export const rateLimitedError = () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down and retry shortly.');

const sessionOrIp = (request: FastifyRequest): string =>
  request.device ? `d:${request.device.deviceId}` : request.auth ? `s:${request.auth.sessionId}` : `ip:${request.ip}`;
/**
 * Canonical client key for per-IP buckets: IPv4 unchanged; IPv4-mapped IPv6 collapses to the IPv4 address; any other IPv6
 * address collapses to its /64 prefix (an attacker owning a /64 would otherwise rotate through 2^64 "distinct" keys).
 */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array<string>(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `v6:${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}`;
}
const ipOnly = (request: FastifyRequest): string => `ip:${clientIpKey(request.ip)}`;

const cache = new WeakMap<object, Limiters>();

export function getLimiters(app: FastifyInstance, config: Config): Limiters {
  const root = app.createRateLimit as unknown as object;
  const existing = cache.get(root);
  if (existing) return existing;

  const make = (max: number, keyGenerator: (r: FastifyRequest) => string = sessionOrIp): Limiter => {
    const check = app.createRateLimit({ max, timeWindow: 60_000, keyGenerator });
    return async (request, reply) => {
      const result = await check(request);
      if (result.isAllowed || !result.isExceeded) return;
      reply.header('retry-after', String(Math.max(1, result.ttlInSeconds)));
      throw rateLimitedError();
    };
  };

  const limiters: Limiters = {
    shopRead: make(config.RATE_LIMIT_SHOP_READ_MAX),
    status: make(config.RATE_LIMIT_STATUS_MAX),
    printConfirm: make(config.RATE_LIMIT_PRINT_CONFIRM_MAX),
    documentAccess: make(config.RATE_LIMIT_DOCUMENT_ACCESS_MAX),
    shopMutation: make(config.RATE_LIMIT_SHOP_MUTATION_MAX),
    adminRead: make(config.RATE_LIMIT_ADMIN_READ_MAX),
    adminMutation: make(config.RATE_LIMIT_ADMIN_MUTATION_MAX),
    sseConnect: make(config.RATE_LIMIT_SSE_CONNECT_MAX),
    deviceRead: make(config.RATE_LIMIT_DEVICE_READ_MAX),
    deviceMutation: make(config.RATE_LIMIT_DEVICE_MUTATION_MAX),
    devicePair: make(config.RATE_LIMIT_DEVICE_PAIR_MAX, ipOnly),
    ipCeiling: (max) => make(max, ipOnly)
  };
  cache.set(root, limiters);
  return limiters;
}
