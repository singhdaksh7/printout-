import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { AppContext } from '../routes/context.js';

/**
 * PDF contract facade (printout_buddy_schema.pdf, pages 7-19).
 *
 * Selecting the contract:
 *  - Paths that exist ONLY in the PDF (/me, /orders, /uploads/presign, ...) always answer in the PDF shape.
 *  - Paths that production clients already use with the app-native shape (/shops/{id}, /shops/mine, PATCH /shops/{id}, ...) keep
 *    that shape unless the request carries `X-API-Contract: pdf`; the PDF twin is registered with constraints.contract = 'pdf'.
 *  - Errors on any PDF request are `{ code, message, details: [{ field, reason }] }` instead of the app envelope.
 * Authentication is unchanged: the app-issued bearer access token (or cookie session). The Firebase ID token is accepted only by
 * POST /auth/login, which exchanges it (approved difference from the PDF's "Firebase token on every call").
 */
export const CONTRACT_HEADER = 'x-api-contract';
export const PDF_CONTRACT = 'pdf';

/** Fastify custom constraint strategy: pass in `Fastify({ constraints: { contract: contractConstraint } })`. */
export const contractConstraint = {
  name: 'contract',
  storage() {
    const handlers = new Map<string, unknown>();
    return {
      get: (value: string) => handlers.get(value) ?? null,
      set: (value: string, handler: unknown) => {
        handlers.set(value, handler);
      }
    };
  },
  deriveConstraint(request: { headers: Record<string, string | string[] | undefined> }) {
    return request.headers[CONTRACT_HEADER] === PDF_CONTRACT ? PDF_CONTRACT : undefined;
  },
  mustMatchWhenDerived: false
};

/** Route options for a PDF twin of an existing path (selected by the header). */
export const pdfTwin = { constraints: { contract: PDF_CONTRACT }, config: { pdf: true } } as const;
/** Route options for a PDF-only path. */
export const pdfOnly = { config: { pdf: true } } as const;

export function isPdfRequest(request: FastifyRequest): boolean {
  return request.headers[CONTRACT_HEADER] === PDF_CONTRACT || (request.routeOptions?.config as { pdf?: boolean } | undefined)?.pdf === true;
}

/** PDF error codes keyed by the app's code. Extend here, never inline. */
const CODE_MAP: Record<string, string> = {
  UNAUTHORIZED: 'INVALID_TOKEN',
  ACCOUNT_BLOCKED: 'USER_BLOCKED',
  INVALID_STATUS_TRANSITION: 'INVALID_TRANSITION',
  INVALID_PAYMENT_TRANSITION: 'INVALID_TRANSITION',
  EMAIL_UNAVAILABLE: 'EMAIL_TAKEN',
  DOCUMENT_UNAVAILABLE: 'FILE_DELETED'
};

export interface PdfError {
  code: string;
  message: string;
  details?: Array<{ field: string; reason: string }>;
}

/** Converts the app's error envelope into the PDF error shape. */
export function toPdfError(statusCode: number, appError: { code: string; message: string; details?: unknown }): { statusCode: number; body: PdfError } {
  const details: Array<{ field: string; reason: string }> = [];
  const d = appError.details as { field?: string; fieldErrors?: Record<string, string[]> } | undefined;
  if (d?.field) details.push({ field: d.field, reason: 'invalid' });
  if (d?.fieldErrors) for (const [field, reasons] of Object.entries(d.fieldErrors)) for (const reason of reasons) details.push({ field, reason });
  const code = CODE_MAP[appError.code] ?? appError.code;
  return { statusCode, body: { code, message: appError.message, ...(details.length ? { details } : {}) } };
}

/** `?page=1&limit=20` (default 20, max 50). */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});
export const paginated = <T>(items: T[], page: number, limit: number, total: number) => ({ items, page, limit, total });

/**
 * Calls an existing app route in-process (same guards, validation, rate limits and audit) with the caller's own credentials, and
 * returns the unwrapped `data` on success. A non-2xx answer is rethrown as the AppError it carried, so the facade's error handler
 * renders it. Never forward to a route with a different trust level than the PDF route promises.
 */
export async function forward<T = unknown>(
  app: FastifyInstance,
  request: FastifyRequest,
  call: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; body?: unknown }
): Promise<{ statusCode: number; data: T }> {
  const headers: Record<string, string> = {};
  for (const name of ['authorization', 'cookie', 'x-csrf-token', 'user-agent', 'idempotency-key']) {
    const v = request.headers[name];
    if (typeof v === 'string') headers[name] = v;
  }
  const res = await app.inject({
    method: call.method,
    url: `/api/v1${call.url}`,
    headers: { ...headers, ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(call.body !== undefined ? { payload: JSON.stringify(call.body) } : {}),
    remoteAddress: request.ip
  });
  const parsed = (res.body ? JSON.parse(res.body) : {}) as { data?: T; error?: { code: string; message: string; details?: unknown } };
  if (res.statusCode >= 400) {
    const e = parsed.error ?? { code: 'INTERNAL_ERROR', message: 'Request failed' };
    throw new AppError(res.statusCode, e.code as never, e.message, e.details);
  }
  return { statusCode: res.statusCode, data: (parsed.data ?? (parsed as unknown)) as T };
}

/** Registers every PDF route module. Add new modules here. */
export async function pdfContractRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { pdfCustomerRoutes } = await import('./customer.js');
  const { pdfOwnerAdminRoutes } = await import('./owner-admin.js');
  await app.register((i) => pdfCustomerRoutes(i, ctx));
  await app.register((i) => pdfOwnerAdminRoutes(i, ctx));
}
