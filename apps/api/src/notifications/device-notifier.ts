import type { PrismaClient } from '@prisma/client';
import { subscriptionAllowsIntake } from '../domain/eligibility.js';
import { toSafeSignal, type PushProvider } from './provider.js';
import type { Notifier } from './types.js';

export interface NotifierLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Signals every ACTIVE ANDROID device (with a push token) of a shop that something new needs attention. Fire-and-forget:
 * never throws, never logs tokens. A signal only says "go fetch"; the device calls the authenticated Device API.
 */
export class DeviceNotifier implements Notifier {
  private readonly pending = new Set<Promise<void>>();
  /** Counters for observability/tests (no PII). */
  readonly stats = { sent: 0, failed: 0, invalidTokensCleared: 0, errors: 0 };

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: PushProvider,
    private readonly logger?: NotifierLogger
  ) {}

  notifyNewPrintRequest(shopId: string, orderId: string): void {
    const p: Promise<void> = this.dispatch(shopId, orderId)
      .catch(() => {
        this.stats.errors += 1;
        this.safeLog({ shopId, event: 'notify_error' });
      })
      .finally(() => {
        this.pending.delete(p);
      });
    this.pending.add(p);
  }

  /** Test helper: resolves when all in-flight notifications have settled. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private safeLog(obj: Record<string, unknown>): void {
    try {
      this.logger?.warn(obj, 'device notification issue');
    } catch {
      /* logging must never throw */
    }
  }

  private async dispatch(shopId: string, orderId: string): Promise<void> {
    const signal = toSafeSignal({ type: 'NEW_PRINT_REQUEST', orderId });
    const devices = await this.prisma.shopDevice.findMany({
      where: {
        shopId,
        status: 'ACTIVE',
        revokedAt: null,
        platform: 'ANDROID',
        pushToken: { not: null },
        shop: { status: 'ACTIVE' }
      },
      select: { id: true, pushToken: true, shop: { select: { subscription: { select: { status: true } } } } }
    });
    await Promise.all(
      devices.map(async (d) => {
        const token = d.pushToken;
        if (!token || !subscriptionAllowsIntake(d.shop.subscription)) return;
        try {
          const result = await this.provider.send(token, { ...signal });
          if (result.ok) this.stats.sent += 1;
          else this.stats.failed += 1;
          if (result.invalidToken) {
            // Conditional: only clear if the device still holds that exact token.
            const cleared = await this.prisma.shopDevice.updateMany({
              where: { id: d.id, pushToken: token },
              data: { pushToken: null, pushTokenUpdatedAt: null }
            });
            this.stats.invalidTokensCleared += cleared.count;
          }
        } catch {
          this.stats.errors += 1;
          this.safeLog({ shopId, deviceId: d.id, event: 'provider_error' });
        }
      })
    );
  }
}
