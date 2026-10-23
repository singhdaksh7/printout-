import { SUPPORTED_MIME_TYPES, type SupportedMime } from './protocol.js';

/**
 * Document validation. Runs on the downloaded bytes BEFORE anything is handed to a renderer or the spooler.
 * The server-declared MIME type and the file's magic bytes must agree; the file name is never consulted.
 */
export class ValidationError extends Error {
  constructor(
    public readonly code: 'UNSUPPORTED_TYPE' | 'TYPE_MISMATCH' | 'TOO_LARGE' | 'EMPTY' | 'ENCRYPTED_PDF' | 'MALFORMED' | 'CHECKSUM_MISMATCH',
    message: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const isSupportedMime = (m: string): m is SupportedMime => (SUPPORTED_MIME_TYPES as readonly string[]).includes(m);

export function sniffMime(head: Uint8Array): SupportedMime | null {
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) return 'application/pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'image/png';
  return null;
}

export interface ValidationInput {
  declaredMime: string;
  size: number;
  maxBytes: number;
  head: Uint8Array;
  /** The last bytes of the file (PDF trailer lives there). */
  tail: Uint8Array;
  supported: readonly SupportedMime[];
}

export function validateDocument(input: ValidationInput): SupportedMime {
  if (input.size <= 0) throw new ValidationError('EMPTY', 'The document is empty');
  if (input.size > input.maxBytes) throw new ValidationError('TOO_LARGE', 'The document exceeds the size limit');
  if (!isSupportedMime(input.declaredMime)) throw new ValidationError('UNSUPPORTED_TYPE', 'This document type cannot be printed by the agent');
  if (!input.supported.includes(input.declaredMime)) throw new ValidationError('UNSUPPORTED_TYPE', 'This computer cannot print this document type');
  const sniffed = sniffMime(input.head);
  if (!sniffed) throw new ValidationError('MALFORMED', 'The file content is not a supported document');
  if (sniffed !== input.declaredMime) throw new ValidationError('TYPE_MISMATCH', 'The file content does not match its declared type');
  if (sniffed === 'application/pdf') {
    const trailer = Buffer.from(input.tail).toString('latin1');
    if (!trailer.includes('%%EOF')) throw new ValidationError('MALFORMED', 'The PDF is incomplete');
    // A password-protected PDF cannot be rendered unattended. The /Encrypt entry is in the trailer dictionary.
    if (/\/Encrypt\b/.test(trailer)) throw new ValidationError('ENCRYPTED_PDF', 'The PDF is password protected');
  }
  return sniffed;
}
