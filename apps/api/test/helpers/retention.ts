import { randomUUID } from 'node:crypto';
import { DocumentStatus, OrderStatus, type PrismaClient } from '@prisma/client';
import type { CleanupStorage } from '../../src/cleanup.js';

/** In-memory storage implementing the delete/exists slice used by cleanup. */
export class MemoryStorage implements CleanupStorage {
  readonly objects = new Set<string>();
  deleteCalls = 0;
  put(key: string) { this.objects.add(key); }
  async delete(key: string) { this.deleteCalls += 1; this.objects.delete(key); }
  async exists(key: string) { return this.objects.has(key); }
}

/** delete() always throws (message contains a fake path/secret that must never be persisted). */
export class FailingStorage extends MemoryStorage {
  override async delete(_key: string): Promise<never> {
    this.deleteCalls += 1;
    throw new Error('EACCES /secret/path/AKIAFAKEKEY');
  }
}

/** delete() fails while `healthy` is false, then behaves normally. */
export class FlakyStorage extends MemoryStorage {
  healthy = false;
  override async delete(key: string) {
    if (!this.healthy) { this.deleteCalls += 1; throw new Error('storage unavailable'); }
    return super.delete(key);
  }
}

/** delete() silently does nothing (object stays) so verification must catch it. */
export class LyingStorage extends MemoryStorage {
  override async delete(_key: string) { this.deleteCalls += 1; }
}

export async function makeShop(prisma: PrismaClient, slug = `shop-${randomUUID().slice(0, 8)}`) {
  return prisma.shop.create({ data: { slug, displayName: slug } });
}

export async function makeDocument(
  prisma: PrismaClient,
  storage: MemoryStorage | null,
  shopId: string,
  data: Partial<{
    status: DocumentStatus; uploadedAt: Date; expiresAt: Date | null; printedAt: Date | null; deleteAfter: Date | null; deletedAt: Date | null; createdAt: Date; withObject: boolean;
  }> = {}
) {
  const objectKey = randomUUID();
  const { withObject = true, ...rest } = data;
  if (withObject) storage?.put(objectKey);
  return prisma.document.create({ data: { shopId, objectKey, originalFilename: 'private-name.pdf', status: DocumentStatus.AVAILABLE, ...rest } });
}

export async function makeOrder(prisma: PrismaClient, shopId: string, documentId: string, status: OrderStatus = OrderStatus.NEW) {
  const id = randomUUID();
  return prisma.order.create({
    data: {
      shopId, documentId, status, orderNumber: `T-${id.slice(0, 8)}`, trackingToken: id, totalPaise: 100,
      priceSnapshot: {}, printOptionsSnapshot: {}, histories: { create: { toStatus: status } }
    }
  });
}

export const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);
