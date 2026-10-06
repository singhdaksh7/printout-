import { createHmac } from 'node:crypto';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** Hard ceiling for UPLOAD_MAX_BYTES (100 MiB). Larger values are refused at startup in every environment. */
export const UPLOAD_HARD_CEILING_BYTES = 104_857_600;

/** Authenticated-surface rate limits (per minute). In NODE_ENV=test the defaults are effectively unlimited. */
const RATE_LIMIT_DEFAULTS = {
  RATE_LIMIT_SHOP_READ_MAX: 600,
  RATE_LIMIT_STATUS_MAX: 120,
  RATE_LIMIT_PRINT_CONFIRM_MAX: 60,
  RATE_LIMIT_DOCUMENT_ACCESS_MAX: 60,
  RATE_LIMIT_SHOP_MUTATION_MAX: 60,
  RATE_LIMIT_ADMIN_READ_MAX: 600,
  RATE_LIMIT_ADMIN_MUTATION_MAX: 60,
  RATE_LIMIT_SSE_CONNECT_MAX: 30,
  /** Device (bearer-credential) surface, per device per minute. */
  RATE_LIMIT_DEVICE_READ_MAX: 300,
  RATE_LIMIT_DEVICE_MUTATION_MAX: 120,
  /** Unauthenticated pairing attempts, per client IP per minute (plus a global ceiling in the pairing route). */
  RATE_LIMIT_DEVICE_PAIR_MAX: 10,
  SSE_MAX_CONNECTIONS_PER_SHOP: 10
} as const;
const TEST_UNLIMITED = 1_000_000;

const optionalPositiveInt = z.coerce.number().int().positive().optional();

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32),
    CSRF_SECRET: z.string().min(32),
    /** Secret for HMAC-signed quote tokens. Required in production; in dev falls back to a key derived from SESSION_SECRET. */
    QUOTE_SECRET: optionalString.pipe(z.string().min(32).optional()),
    /** Dedicated secret for signed storage URLs / upload tokens. Required in production with the local driver. */
    STORAGE_URL_SECRET: optionalString.pipe(z.string().min(32).optional()),
    QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    /** Optional absolute base for API URLs handed to browsers (e.g. https://api.example.com). */
    PUBLIC_API_BASE: optionalString.pipe(z.string().url().optional()),
    /** Production must set this (or TRUST_PROXY_CIDRS) explicitly. Unset = no proxy trust (safe for local dev). */
    TRUST_PROXY: bool.optional(),
    /**
     * Comma-separated IPs/CIDRs (or proxy-addr names: loopback, linklocal, uniquelocal) of the reverse proxies to trust
     * for X-Forwarded-For (takes precedence over TRUST_PROXY), e.g. "loopback,linklocal,uniquelocal" or
     * "127.0.0.1,172.16.0.0/12". The client IP is the first address from the right that is NOT a trusted proxy, so a
     * client cannot spoof its IP (and dodge rate limits / login throttling) by sending its own X-Forwarded-For.
     * TRUST_PROXY=true trusts every hop and is spoofable unless the proxy overwrites the header.
     */
    TRUST_PROXY_CIDRS: optionalString.pipe(z.string().regex(/^[A-Za-z0-9:./,\s-]+$/).optional()),
    JSON_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),

    /** Authoritative app-level cap (raw PUT body). The reverse proxy cap must be >= this + 1 MiB. */
    UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(UPLOAD_HARD_CEILING_BYTES).default(52_428_800),
    UPLOAD_MAX_PDF_PAGES: z.coerce.number().int().positive().default(200),
    PRINT_RETENTION_MINUTES: z.coerce.number().int().positive().default(30),
    UNPRINTED_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
    DOCUMENT_CLEANUP_INTERVAL_MINUTES: z.coerce.number().positive().default(1),
    DOCUMENT_CLEANUP_BATCH_SIZE: z.coerce.number().int().positive().default(100),
    DOCUMENT_STALE_UPLOAD_MINUTES: z.coerce.number().int().positive().default(60),

    SESSION_DAYS: z.coerce.number().int().positive().default(7),
    COOKIE_SAMESITE: z.enum(['lax', 'strict']).default('lax'),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    LOGIN_FAIL_MAX: z.coerce.number().int().positive().default(5),
    LOGIN_FAIL_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
    PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    /** Must stay below typical proxy idle timeouts (60s); production enforces <= 25s (a >2x margin). */
    SSE_HEARTBEAT_MS: z.coerce.number().int().min(100).default(25_000),
    RATE_LIMIT_SHOP_READ_MAX: optionalPositiveInt,
    RATE_LIMIT_STATUS_MAX: optionalPositiveInt,
    RATE_LIMIT_PRINT_CONFIRM_MAX: optionalPositiveInt,
    RATE_LIMIT_DOCUMENT_ACCESS_MAX: optionalPositiveInt,
    RATE_LIMIT_SHOP_MUTATION_MAX: optionalPositiveInt,
    RATE_LIMIT_ADMIN_READ_MAX: optionalPositiveInt,
    RATE_LIMIT_ADMIN_MUTATION_MAX: optionalPositiveInt,
    RATE_LIMIT_SSE_CONNECT_MAX: optionalPositiveInt,
    RATE_LIMIT_DEVICE_READ_MAX: optionalPositiveInt,
    RATE_LIMIT_DEVICE_MUTATION_MAX: optionalPositiveInt,
    RATE_LIMIT_DEVICE_PAIR_MAX: optionalPositiveInt,
    /** Pairing codes live this long and are single use. */
    DEVICE_PAIRING_TTL_MINUTES: z.coerce.number().positive().default(10),
    /** Heartbeats only write lastSeenAt when the stored value is older than this (limits DB write load). */
    DEVICE_LASTSEEN_WRITE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(30),
    SSE_MAX_CONNECTIONS_PER_SHOP: optionalPositiveInt,

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    LOCAL_UPLOAD_DIR: z.string().default('.data/uploads'),
    S3_ENDPOINT: optionalString,
    S3_REGION: optionalString,
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: bool.default('false'),
    /** Production + STORAGE_DRIVER=local is refused unless explicitly acknowledged (single node, unbacked-up volume). */
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: bool.default('false')
  })
  .superRefine((cfg, ctx) => {
    if (cfg.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!cfg[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER=s3` });
      }
    }
    if (cfg.NODE_ENV === 'production') {
      const weak = /replace|change-me|change-this|secret-0123|example|password|changeme/i;
      const secrets: Array<[string, string | undefined, boolean]> = [
        ['SESSION_SECRET', cfg.SESSION_SECRET, true],
        ['CSRF_SECRET', cfg.CSRF_SECRET, true],
        ['QUOTE_SECRET', cfg.QUOTE_SECRET, true],
        ['STORAGE_URL_SECRET', cfg.STORAGE_URL_SECRET, cfg.STORAGE_DRIVER === 'local']
      ];
      for (const [key, value, required] of secrets) {
        if (value === undefined) {
          if (required) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production (>= 32 random chars)` });
          continue;
        }
        if (weak.test(value)) ctx.addIssue({ code: 'custom', path: [key], message: `${key} looks like a placeholder; set a long random value in production` });
      }
      const given = secrets.filter((s): s is [string, string, boolean] => s[1] !== undefined);
      for (let i = 0; i < given.length; i++) {
        for (let j = i + 1; j < given.length; j++) {
          if (given[i]![1] === given[j]![1]) {
            ctx.addIssue({ code: 'custom', path: [given[j]![0]], message: `${given[j]![0]} must differ from ${given[i]![0]} in production` });
          }
        }
      }
      if (/:change-me@|:password@|:postgres@/.test(cfg.DATABASE_URL)) {
        ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL uses a default/placeholder password' });
      }
      const origin = safeUrl(cfg.WEB_ORIGIN);
      if (!origin || origin.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'WEB_ORIGIN must be an https:// URL in production' });
      } else if (/^(localhost|127\.|\[?::1)/i.test(origin.hostname)) {
        ctx.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'WEB_ORIGIN must not point at localhost in production' });
      }
      if (cfg.PUBLIC_API_BASE && safeUrl(cfg.PUBLIC_API_BASE)?.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_API_BASE'], message: 'PUBLIC_API_BASE must be https:// in production' });
      }
      if (cfg.SSE_HEARTBEAT_MS > 25_000) {
        ctx.addIssue({ code: 'custom', path: ['SSE_HEARTBEAT_MS'], message: 'SSE_HEARTBEAT_MS must be <= 25000 in production (proxy idle timeouts)' });
      }
      if (cfg.TRUST_PROXY === undefined && cfg.TRUST_PROXY_CIDRS === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['TRUST_PROXY'],
          message: 'TRUST_PROXY (false|true) or TRUST_PROXY_CIDRS (e.g. loopback,linklocal,uniquelocal) must be set explicitly in production'
        });
      }
      if (cfg.STORAGE_DRIVER === 'local' && !cfg.ALLOW_LOCAL_STORAGE_IN_PRODUCTION) {
        ctx.addIssue({
          code: 'custom',
          path: ['STORAGE_DRIVER'],
          message:
            'STORAGE_DRIVER=local in production requires ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true (single node, volume not backed up); use s3 (private R2/S3 bucket)'
        });
      }
      if (cfg.STORAGE_DRIVER === 's3') {
        if (cfg.S3_ENDPOINT && safeUrl(cfg.S3_ENDPOINT)?.protocol !== 'https:') {
          ctx.addIssue({ code: 'custom', path: ['S3_ENDPOINT'], message: 'S3_ENDPOINT must be https:// in production' });
        }
        for (const key of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'] as const) {
          const value = cfg[key];
          if (value && weak.test(value)) ctx.addIssue({ code: 'custom', path: [key], message: `${key} looks like a placeholder` });
        }
      }
    }
  })
  .transform((cfg) => {
    const test = cfg.NODE_ENV === 'test';
    const limits = {} as { -readonly [K in keyof typeof RATE_LIMIT_DEFAULTS]: number };
    for (const key of Object.keys(RATE_LIMIT_DEFAULTS) as Array<keyof typeof RATE_LIMIT_DEFAULTS>) {
      limits[key] = cfg[key] ?? (test ? TEST_UNLIMITED : RATE_LIMIT_DEFAULTS[key]);
    }
    return { ...cfg, ...limits, TRUST_PROXY: cfg.TRUST_PROXY ?? false };
  });

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export type Config = z.infer<typeof schema>;

/** Startup configuration failure: the message lists every problem (variable names + reasons, never values). */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parses and validates the environment; throws ConfigError (no secret values in the message). */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`));
  }
  return result.data;
};

/** Non-fatal findings worth logging loudly at startup. */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (config.NODE_ENV === 'production') {
    if (config.TRUST_PROXY && !config.TRUST_PROXY_CIDRS) {
      warnings.push('TRUST_PROXY=true trusts every X-Forwarded-For hop; prefer TRUST_PROXY_CIDRS=loopback,linklocal,uniquelocal (Caddy on the docker network)');
    }
    if (config.STORAGE_DRIVER === 'local') {
      warnings.push('STORAGE_DRIVER=local in production: documents live on a single-node volume that is not backed up');
    }
    if (config.UPLOAD_MAX_BYTES > 52_428_800) {
      warnings.push(`UPLOAD_MAX_BYTES=${config.UPLOAD_MAX_BYTES}: the reverse proxy body cap must be at least UPLOAD_MAX_BYTES + 1 MiB`);
    }
  }
  return warnings;
}

/** Quote-token signing key: QUOTE_SECRET, or a purpose-bound key derived from SESSION_SECRET. */
export function quoteSecret(config: Pick<Config, 'QUOTE_SECRET' | 'SESSION_SECRET'>): string {
  return config.QUOTE_SECRET ?? createHmac('sha256', config.SESSION_SECRET).update('printout:quote:v1').digest('hex');
}
