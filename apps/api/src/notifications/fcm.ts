import { getMessaging } from 'firebase-admin/messaging';
import type { Config } from '../config.js';
import { firebaseAdminApp } from '../firebase/verifier.js';
import type { AppContext } from '../routes/context.js';
import { decryptFcmToken, fcmKey, revokeById } from './fcm-registrations.js';

/**
 * Push to mobile shop owners. The payload is deliberately minimal: a generic title, an event type and the order id. NO file names,
 * customer data, URLs or tokens ever go through FCM; the app fetches details with its own authenticated API calls.
 */
export interface PushMessage {
  /** e.g. 'order.new' */
  type: string;
  orderId: string;
  title: string;
}

export interface PushResult {
  ok: boolean;
  /** FCM error code when !ok, e.g. messaging/registration-token-not-registered. */
  code?: string;
}

export interface PushSender {
  /** One result per token, same order. Must not throw for per-token failures. */
  send(tokens: string[], message: PushMessage): Promise<PushResult[]>;
}

/** Tokens FCM says will never work again: the registration is revoked immediately. */
export const PERMANENT_FCM_ERRORS = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

export class FirebasePushSender implements PushSender {
  constructor(private readonly projectId: string) {}

  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    if (tokens.length === 0) return [];
    try {
      const res = await getMessaging(firebaseAdminApp(this.projectId)).sendEach(
        tokens.map((token) => ({
          token,
          notification: { title: message.title },
          data: { type: message.type, orderId: message.orderId },
          android: { priority: 'high' as const }
        }))
      );
      return res.responses.map((r) => (r.success ? { ok: true } : { ok: false, code: r.error?.code ?? 'messaging/unknown' }));
    } catch {
      // Whole-batch failure (credentials, network): transient for every token.
      return tokens.map(() => ({ ok: false, code: 'messaging/unavailable' }));
    }
  }
}

/** The real sender, or null unless push is enabled AND a Firebase project is configured. */
export function createPushSender(config: Config): PushSender | null {
  if (!config.FCM_PUSH_ENABLED || !config.FIREBASE_PROJECT_ID) return null;
  return new FirebasePushSender(config.FIREBASE_PROJECT_ID);
}

type RegistrationWhere = Parameters<AppContext['prisma']['fcmRegistration']['findMany']>[0] extends infer A ? (A extends { where?: infer W } ? W : never) : never;

/** Shared delivery: decrypt, send, and clean up registrations FCM reports as permanently dead (or failing too often). Never throws. */
async function deliver(ctx: AppContext, where: RegistrationWhere, message: PushMessage): Promise<void> {
  const { prisma, config } = ctx;
  const sender = ctx.pushSender;
  if (!sender || !config.FCM_PUSH_ENABLED) return;
  try {
    const key = fcmKey(config);
    const staleBefore = new Date(Date.now() - config.FCM_STALE_DAYS * 86_400_000);
    const rows = await prisma.fcmRegistration.findMany({
      where: { ...where, enabled: true, revokedAt: null, lastRegisteredAt: { gte: staleBefore } },
      select: { id: true, tokenCipher: true, failureCount: true },
      take: 100
    });
    const live: Array<{ id: string; token: string; failureCount: number }> = [];
    for (const r of rows) {
      const token = decryptFcmToken(key, r.tokenCipher);
      if (token) live.push({ id: r.id, token, failureCount: r.failureCount });
      else await revokeById(prisma, r.id); // sealed with a key we no longer have: useless, drop it
    }
    if (live.length === 0) return;
    const results = await sender.send(live.map((l) => l.token), message);
    for (const [i, reg] of live.entries()) {
      const res = results[i] ?? { ok: false, code: 'messaging/unknown' };
      if (res.ok) {
        await prisma.fcmRegistration.updateMany({ where: { id: reg.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } });
      } else if (res.code && PERMANENT_FCM_ERRORS.has(res.code)) {
        await revokeById(prisma, reg.id);
      } else if (reg.failureCount + 1 >= config.FCM_FAILURE_REVOKE_AFTER) {
        await revokeById(prisma, reg.id);
      } else {
        await prisma.fcmRegistration.updateMany({ where: { id: reg.id }, data: { failureCount: { increment: 1 } } });
      }
    }
  } catch {
    /* push is best effort: never surfaces to the order flow */
  }
}

/**
 * Post-commit, best-effort push to the OWNERS OF THIS SHOP only. Never throws and never delays the request that created the order.
 * Tenant isolation: registrations are selected by shopId AND the user must still belong to that shop.
 */
export async function notifyShopOwners(ctx: AppContext, shopId: string, message: PushMessage): Promise<void> {
  await deliver(ctx, { shopId, user: { role: 'SHOP_OWNER', shopId } }, message);
}

/** Post-commit, best-effort push to ONE customer's own devices (registrations are scoped by user id and the CUSTOMER role). */
export async function notifyUser(ctx: AppContext, userId: string, message: PushMessage): Promise<void> {
  await deliver(ctx, { userId, user: { id: userId, role: 'CUSTOMER', isActive: true } }, message);
}
