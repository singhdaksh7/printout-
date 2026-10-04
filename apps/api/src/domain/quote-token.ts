import { createHmac } from 'node:crypto';
import { AppError } from '../errors.js';
import { equalToken } from '../auth.js';
import { printOptionsSchema, type PrintOptions } from './pricing.js';

/**
 * Quote tokens are stateless and HMAC-signed. They bind *intent* (document, shop, options, expiry) but
 * deliberately carry no price: order creation re-loads the document and CURRENT pricing rules and
 * recalculates the total server-side.
 */
export interface QuotePayload {
  documentId: string;
  shopId: string;
  printOptions: PrintOptions;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const VERSION = 'q1';
const sign = (secret: string, body: string) =>
  createHmac('sha256', secret).update(`${VERSION}.${body}`).digest('base64url');

export function signQuote(secret: string, payload: QuotePayload): string {
  const body = Buffer.from(
    JSON.stringify({ d: payload.documentId, s: payload.shopId, o: payload.printOptions, e: payload.expiresAt })
  ).toString('base64url');
  return `${VERSION}.${body}.${sign(secret, body)}`;
}

export function verifyQuote(secret: string, token: string, now = Date.now()): QuotePayload {
  const invalid = () => new AppError(422, 'INVALID_QUOTE', 'Quote is invalid');
  if (token.length > 4096) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) throw invalid();
  const [, body, signature] = parts as [string, string, string];
  if (!equalToken(sign(secret, body), signature)) throw invalid();
  let raw: { d?: unknown; s?: unknown; o?: unknown; e?: unknown };
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const options = printOptionsSchema.safeParse(raw.o);
  if (typeof raw.d !== 'string' || typeof raw.s !== 'string' || typeof raw.e !== 'number' || !options.success) {
    throw invalid();
  }
  if (raw.e <= now) throw new AppError(422, 'QUOTE_EXPIRED', 'Quote has expired; request a new quote');
  return { documentId: raw.d, shopId: raw.s, printOptions: options.data, expiresAt: raw.e };
}
