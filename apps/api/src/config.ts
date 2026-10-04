import { createHmac } from 'node:crypto';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

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
    /** Secret for HMAC-signed quote tokens. Falls back to a key derived from SESSION_SECRET. */
    QUOTE_SECRET: optionalString.pipe(z.string().min(32).optional()),
    /** Optional dedicated secret for signed storage URLs / upload tokens (FILES). */
    STORAGE_URL_SECRET: optionalString.pipe(z.string().min(32).optional()),
    QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    /** Optional absolute base for API URLs handed to browsers (e.g. https://api.example.com). */
    PUBLIC_API_BASE: optionalString.pipe(z.string().url().optional()),
    TRUST_PROXY: bool.default('false'),
    /**
     * Comma-separated IPs/CIDRs of the reverse proxies to trust for X-Forwarded-For (takes precedence over TRUST_PROXY),
     * e.g. "127.0.0.1,172.16.0.0/12". The client IP is the first address from the right that is NOT a trusted proxy, so a
     * client cannot spoof its IP (and dodge rate limits / login throttling) by sending its own X-Forwarded-For.
     * TRUST_PROXY=true trusts every hop and is spoofable unless the proxy overwrites the header.
     */
    TRUST_PROXY_CIDRS: optionalString.pipe(z.string().regex(/^[A-Za-z0-9:./,\s-]+$/).optional()),
    JSON_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),

    UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(52_428_800),
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
    SSE_HEARTBEAT_MS: z.coerce.number().int().min(100).default(25_000),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    LOCAL_UPLOAD_DIR: z.string().default('.data/uploads'),
    S3_ENDPOINT: optionalString,
    S3_REGION: optionalString,
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: bool.default('false')
  })
  .superRefine((cfg, ctx) => {
    if (cfg.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!cfg[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER=s3` });
      }
    }
    if (cfg.NODE_ENV === 'production') {
      const weak = /replace|change-me|change-this|secret-0123|example|password/i;
      for (const key of ['SESSION_SECRET', 'CSRF_SECRET', 'QUOTE_SECRET'] as const) {
        const value = cfg[key];
        if (value !== undefined && weak.test(value)) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} looks like a placeholder; set a long random value in production` });
        }
      }
      if (cfg.SESSION_SECRET === cfg.CSRF_SECRET) {
        ctx.addIssue({ code: 'custom', path: ['CSRF_SECRET'], message: 'CSRF_SECRET must differ from SESSION_SECRET in production' });
      }
      if (/:change-me@/.test(cfg.DATABASE_URL)) {
        ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL uses the default development password' });
      }
      if (!cfg.WEB_ORIGIN.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'WEB_ORIGIN must be https in production' });
      }
    }
  });

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);

/** Quote-token signing key: QUOTE_SECRET, or a purpose-bound key derived from SESSION_SECRET. */
export function quoteSecret(config: Pick<Config, 'QUOTE_SECRET' | 'SESSION_SECRET'>): string {
  return config.QUOTE_SECRET ?? createHmac('sha256', config.SESSION_SECRET).update('printout:quote:v1').digest('hex');
}
