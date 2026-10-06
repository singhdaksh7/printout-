import { z } from 'zod';
import type { DeviceSignal } from './types.js';

/** Result of one push attempt. `invalidToken` means the provider says the token is permanently dead (unregistered). */
export interface PushResult {
  ok: boolean;
  invalidToken?: boolean;
}

export interface PushProvider {
  send(token: string, payload: DeviceSignal): Promise<PushResult>;
}

const signalSchema = z
  .object({
    type: z.literal('NEW_PRINT_REQUEST'),
    orderId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
  })
  .strict();

/**
 * Runtime guard for the push payload. Rejects (throws) anything but exactly {type, orderId}, so URLs, storage keys,
 * file names or credentials can never be smuggled into a notification. Returns a fresh object.
 */
export function toSafeSignal(input: unknown): DeviceSignal {
  const parsed = signalSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid push payload');
  return { type: parsed.data.type, orderId: parsed.data.orderId };
}
