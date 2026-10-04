import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'PDF_TOO_MANY_PAGES'
  | 'INVALID_PDF'
  | 'PASSWORD_PROTECTED_PDF'
  | 'INVALID_PAGE_RANGE'
  | 'ORDER_NOT_FOUND'
  | 'DOCUMENT_UNAVAILABLE'
  | 'INVALID_STATUS_TRANSITION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CSRF_INVALID'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INVALID_QUOTE'
  | 'QUOTE_EXPIRED'
  | 'NO_PRICING_RULE'
  | 'SHOP_UNAVAILABLE'
  // Additive codes (documented in docs/API_CONTRACT.md)
  | 'INVALID_CREDENTIALS'
  | 'SHOP_SUSPENDED'
  | 'DOCUMENT_ALREADY_USED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DUPLICATE_PRICING_RULE'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const orderNotFound = () => new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

export interface ErrorEnvelope {
  error: { code: ErrorCode | string; message: string; requestId: string; details?: unknown };
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED'
};

export function toEnvelope(error: unknown, requestId: string): { statusCode: number; body: ErrorEnvelope } {
  if (error instanceof AppError) {
    const inner: ErrorEnvelope['error'] = { code: error.code, message: error.message, requestId };
    if (error.details !== undefined) inner.details = error.details;
    return { statusCode: error.statusCode, body: { error: inner } };
  }
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', requestId, details: error.flatten() } }
    };
  }
  const status = (error as FastifyError | undefined)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code = STATUS_CODES[status] ?? 'VALIDATION_ERROR';
    // Fastify's own 4xx messages (bad JSON, payload too large, ...) are safe to surface.
    return { statusCode: status, body: { error: { code, message: (error as Error).message, requestId } } };
  }
  return {
    statusCode: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } }
  };
}

/** Registers the error + not-found handlers. 5xx never leaks internal messages or stacks. */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const { statusCode, body } = toEnvelope(error, request.id);
    if (statusCode >= 500) request.log.error({ err: error, requestId: request.id }, 'request failed');
    else request.log.info({ code: body.error.code, requestId: request.id, statusCode }, 'request rejected');
    if (reply.sent) return;
    void reply.status(statusCode).send(body);
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id }
    } satisfies ErrorEnvelope);
  });
}
