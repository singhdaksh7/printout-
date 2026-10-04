/**
 * In-process, per-shop server-sent-event bus.
 *
 * - `emit(shopId, event, data)` is the public API for any producer (routes, the retention worker, ...).
 *   Payloads must be minimal: ids, statuses, timestamps. Never URLs, content or storage keys.
 * - Event ids are monotonic per process (seeded from the clock so they also increase across restarts).
 * - A small ring buffer per shop supports `Last-Event-ID` replay.
 * - Delivery is strictly per shop.
 *
 * NOTE: the bus is in-memory. A worker running in a separate process cannot reach browser connections
 * through it; cross-process fan-out would need e.g. Postgres LISTEN/NOTIFY (documented known gap).
 */
export interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
}

export interface EventSink {
  write(chunk: string): void;
  close(): void;
}

export const SHOP_EVENT_NAMES = [
  'order.created',
  'order.updated',
  'order.statusChanged',
  'document.deletionScheduled',
  'document.deleted'
] as const;
export type ShopEventName = (typeof SHOP_EVENT_NAMES)[number];

export function formatSse(item: BufferedEvent): string {
  return `id: ${item.id}\nevent: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`;
}

export class ShopEvents {
  private readonly sinks = new Map<string, Set<EventSink>>();
  private readonly buffers = new Map<string, BufferedEvent[]>();
  private seq = Date.now();

  constructor(private readonly bufferSize = 200) {}

  /** Publishes an event to every connection of one shop. Returns the assigned event id. */
  emit(shopId: string, event: ShopEventName | string, data: unknown): number {
    const item: BufferedEvent = { id: ++this.seq, event, data };
    const buffer = this.buffers.get(shopId) ?? [];
    buffer.push(item);
    if (buffer.length > this.bufferSize) buffer.splice(0, buffer.length - this.bufferSize);
    this.buffers.set(shopId, buffer);
    const payload = formatSse(item);
    for (const sink of [...(this.sinks.get(shopId) ?? [])]) {
      try {
        sink.write(payload);
      } catch {
        this.remove(shopId, sink);
      }
    }
    return item.id;
  }

  /** Registers a sink, replays buffered events newer than `lastEventId`, returns an unsubscribe function. */
  subscribe(shopId: string, sink: EventSink, lastEventId?: number): () => void {
    sink.write('retry: 3000\n\n');
    if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
      for (const item of this.buffers.get(shopId) ?? []) if (item.id > lastEventId) sink.write(formatSse(item));
    }
    const set = this.sinks.get(shopId) ?? new Set<EventSink>();
    set.add(sink);
    this.sinks.set(shopId, set);
    return () => this.remove(shopId, sink);
  }

  connectionCount(shopId: string): number {
    return this.sinks.get(shopId)?.size ?? 0;
  }

  /** Ends every open stream (used on shutdown). */
  closeAll(): void {
    for (const [shopId, set] of this.sinks) {
      for (const sink of [...set]) {
        this.remove(shopId, sink);
        try {
          sink.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  private remove(shopId: string, sink: EventSink): void {
    const set = this.sinks.get(shopId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.sinks.delete(shopId);
  }
}
