import type { Prisma, PrismaClient, ShopNotification } from '@prisma/client';

/**
 * Durable in-app notifications for shop owners.
 *
 * Delivery model (see docs/REALTIME_NOTIFICATIONS.md):
 *  1. `recordOrderCreated` writes the notification row INSIDE the order-creation transaction (transactional outbox):
 *     committed order <=> committed notification, never one without the other.
 *  2. After commit, the creating process calls `hub.publish` (fast path, best effort, never throws).
 *  3. Other API processes find the row through the hub's poller (bounded, only while a stream is open).
 *  4. The database is the source of truth: clients recover anything they missed with the cursor list endpoint.
 *
 * Payloads carry ONLY safe metadata (order id and number). Never URLs, storage keys, file names or customer data.
 */
export const ORDER_CREATED = 'order.created';
export const NOTIFICATION_EVENT = 'notification.created';

export interface NotificationDto {
  id: string;
  /** Monotonic replay cursor (decimal string; BigInt does not survive JSON). */
  seq: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  data: { orderId: string; orderNumber: string };
}

/** Whitelists fields explicitly so a future payload addition can never leak through the API by accident. */
export function toNotificationDto(
  row: Pick<ShopNotification, 'id' | 'seq' | 'type' | 'orderId' | 'payload' | 'createdAt' | 'readAt'>
): NotificationDto {
  const payload = (row.payload ?? {}) as { orderId?: unknown; orderNumber?: unknown };
  return {
    id: row.id,
    seq: row.seq.toString(),
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
    data: {
      orderId: typeof payload.orderId === 'string' ? payload.orderId : (row.orderId ?? ''),
      orderNumber: typeof payload.orderNumber === 'string' ? payload.orderNumber : ''
    }
  };
}

/** Idempotent: the (shopId, dedupeKey) unique key means replaying this for the same order is a no-op. */
export function recordOrderCreated(tx: Prisma.TransactionClient, input: { shopId: string; orderId: string; orderNumber: string }) {
  const dedupeKey = `${ORDER_CREATED}:${input.orderId}`;
  return tx.shopNotification.upsert({
    where: { shopId_dedupeKey: { shopId: input.shopId, dedupeKey } },
    create: {
      shopId: input.shopId,
      type: ORDER_CREATED,
      orderId: input.orderId,
      dedupeKey,
      payload: { orderId: input.orderId, orderNumber: input.orderNumber }
    },
    update: {}
  });
}

export function retentionCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

/** Deletes notifications past retention in bounded batches. Run by the retention worker; never touches orders. */
export async function cleanupNotifications(
  prisma: PrismaClient,
  opts: { retentionDays: number; now?: Date; batchSize?: number }
): Promise<{ deleted: number }> {
  const cutoff = retentionCutoff(opts.retentionDays, opts.now);
  const batch = opts.batchSize ?? 500;
  let deleted = 0;
  for (;;) {
    const rows = await prisma.shopNotification.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: batch });
    if (rows.length === 0) break;
    const res = await prisma.shopNotification.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    deleted += res.count;
    if (rows.length < batch) break;
  }
  return { deleted };
}

export interface NotificationSubscriber {
  /** Called with new notifications for the subscribed shop only. Must not throw. */
  deliver(items: NotificationDto[]): void;
}

interface Entry {
  sub: NotificationSubscriber;
  /** Highest seq already handed to this subscriber: drops duplicates (fast path + poller) and reordering. */
  last: bigint;
}

const POLL_BATCH = 200;

/**
 * Per-shop fan-out of notifications to open streams on THIS process.
 * Cross-process: a single lightweight poller runs while at least one stream is open (no Redis / broker needed).
 * Ordering: per shop, notification seq order equals commit order because order creation row-locks the shop.
 */
export class ShopNotificationHub {
  private readonly entries = new Map<string, Set<Entry>>();
  private timer: NodeJS.Timeout | undefined;
  private cursor = 0n;
  private polling = false;
  private starting: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly pollMs: number,
    private readonly onError: (err: unknown) => void = () => undefined
  ) {}

  /** Registers a subscriber and (if needed) starts the poller. Resolves once the poller baseline is set. */
  async subscribe(shopId: string, sub: NotificationSubscriber): Promise<() => void> {
    const entry: Entry = { sub, last: 0n };
    const set = this.entries.get(shopId) ?? new Set<Entry>();
    set.add(entry);
    this.entries.set(shopId, set);
    await this.ensurePolling();
    // Baseline: this subscriber is only pushed rows created AFTER it subscribed. Anything older (including rows the shared
    // poller has not delivered yet) is history the client reconciles through the cursor list, never a "live" push.
    try {
      const max = await this.prisma.shopNotification.aggregate({ _max: { seq: true } });
      const newest = max._max.seq ?? 0n;
      if (newest > entry.last) entry.last = newest;
    } catch (err) {
      this.onError(err);
    }
    return () => {
      const current = this.entries.get(shopId);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) this.entries.delete(shopId);
      if (this.entries.size === 0) this.stopPolling();
    };
  }

  /** Fast path after commit. Never throws: a failed fan-out must not affect the caller (the DB row is the truth). */
  publish(shopId: string, dto: NotificationDto): void {
    this.dispatch(shopId, dto);
  }

  subscriberCount(): number {
    let n = 0;
    for (const set of this.entries.values()) n += set.size;
    return n;
  }

  isPolling(): boolean {
    return this.timer !== undefined;
  }

  close(): void {
    this.entries.clear();
    this.stopPolling();
  }

  private dispatch(shopId: string, dto: NotificationDto): void {
    const set = this.entries.get(shopId);
    if (!set) return;
    const seq = BigInt(dto.seq);
    for (const entry of [...set]) {
      if (seq <= entry.last) continue;
      entry.last = seq;
      try {
        entry.sub.deliver([dto]);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  private async ensurePolling(): Promise<void> {
    if (this.pollMs <= 0 || this.timer) return this.starting;
    // The baseline is the newest existing row: anything older is recovered by the client's cursor list on connect.
    this.starting ??= (async () => {
      try {
        const max = await this.prisma.shopNotification.aggregate({ _max: { seq: true } });
        this.cursor = max._max.seq ?? 0n;
      } catch (err) {
        this.onError(err);
      }
      if (this.entries.size > 0 && !this.timer) {
        this.timer = setInterval(() => void this.poll(), this.pollMs);
        this.timer.unref();
      }
      this.starting = undefined;
    })();
    return this.starting;
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.entries.size === 0) return;
    this.polling = true;
    try {
      for (;;) {
        const rows = await this.prisma.shopNotification.findMany({
          where: { seq: { gt: this.cursor } },
          orderBy: { seq: 'asc' },
          take: POLL_BATCH
        });
        for (const row of rows) {
          this.cursor = row.seq;
          this.dispatch(row.shopId, toNotificationDto(row));
        }
        if (rows.length < POLL_BATCH) break;
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.polling = false;
    }
  }
}
