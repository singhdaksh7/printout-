import { DocumentStatus, OrderStatus, type Document, type Order, type OrderStatusHistory, type Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { cursorWhere, decodeCursor, encodeCursor } from '../routes/context.js';
import { TERMINAL_STATUSES } from './lifecycle.js';

/**
 * Order view shapes shared by the owner (cookie) routes and the device (Bearer) routes: ONE business model.
 * Nothing here may expose object keys, buckets, URLs or credentials.
 */
interface PriceSnapshot {
  selectedPageCount?: number;
}
interface OptionsSnapshot {
  colourMode?: string;
  sides?: string;
  copies?: number;
  pageSelection?: unknown;
  paperSize?: string;
}

export const orderCore = (o: Order) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  status: o.status,
  totalPaise: o.totalPaise,
  currency: o.currency,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt
});

export const toStatusEvent = (o: Order) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status, updatedAt: o.updatedAt });

export function orderListItem(o: Order & { document: Document }) {
  const options = o.printOptionsSnapshot as OptionsSnapshot;
  return {
    ...orderCore(o),
    customerDisplayNameOrReference: o.customerDisplayNameOrReference,
    originalFilename: o.document.originalFilename,
    pageCount: o.document.pageCount,
    selectedPageCount: (o.priceSnapshot as PriceSnapshot).selectedPageCount ?? null,
    colourMode: options.colourMode ?? null,
    sides: options.sides ?? null,
    copies: options.copies ?? null,
    documentStatus: o.document.status,
    deleteAfter: o.document.deleteAfter,
    printInitiatedAt: o.document.printInitiatedAt ?? o.document.printedAt,
    paperSize: options.paperSize ?? null,
    pageSelection: options.pageSelection ?? null
  };
}

export function orderDetail(order: Order & { document: Document; histories: OrderStatusHistory[] }) {
  const d = order.document;
  return {
    order: {
      ...orderCore(order),
      customerDisplayNameOrReference: order.customerDisplayNameOrReference,
      originalFilename: d.originalFilename,
      selectedPageCount: (order.priceSnapshot as PriceSnapshot).selectedPageCount ?? null
    },
    document: {
      id: d.id,
      status: d.status,
      fileName: d.originalFilename,
      mimeType: d.detectedMimeType,
      pageCount: d.pageCount,
      uploadedAt: d.uploadedAt,
      expiresAt: d.expiresAt,
      printedAt: d.printedAt,
      printInitiatedAt: d.printInitiatedAt,
      deleteAfter: d.deleteAfter,
      deletedAt: d.deletedAt,
      deletionState: d.status === DocumentStatus.DELETED ? 'DELETED' : d.deletionError ? 'FAILED' : 'OK'
    },
    priceSnapshot: order.priceSnapshot,
    printOptionsSnapshot: order.printOptionsSnapshot,
    statusHistory: order.histories.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      reason: h.reason,
      createdAt: h.createdAt
    }))
  };
}

export const orderListQuery = z
  .object({
    /** One status or a comma-separated list. */
    status: z.string().max(200).optional(),
    /** active=1 hides terminal orders (COLLECTED, CANCELLED, EXPIRED). */
    active: z.enum(['1', 'true', '0', 'false']).optional(),
    /** pending = Print not yet pressed; initiated = Print pressed (or legacy print-confirmed). */
    print: z.enum(['pending', 'initiated']).optional(),
    cursor: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  })
  .strict();
export type OrderListQuery = z.infer<typeof orderListQuery>;

export function parseStatuses(raw: string | undefined): OrderStatus[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const parsed = z.array(z.nativeEnum(OrderStatus)).min(1).max(8).safeParse(values);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid status filter');
  return parsed.data;
}

/** Tenant-scoped, keyset-paginated order list (owner and device share it). */
export async function listOrders(prisma: PrismaClient, shopId: string, q: OrderListQuery) {
  const statuses = parseStatuses(q.status);
  const hideTerminal = q.active === '1' || q.active === 'true';
  const statusFilter: Prisma.OrderWhereInput['status'] = statuses
    ? { in: statuses }
    : hideTerminal
      ? { notIn: TERMINAL_STATUSES as OrderStatus[] }
      : undefined;
  const rows = await prisma.order.findMany({
    where: {
      shopId,
      status: statusFilter,
      ...(q.print === 'initiated' ? { document: { OR: [{ printInitiatedAt: { not: null } }, { printedAt: { not: null } }] } } : {}),
      ...(q.print === 'pending' ? { document: { printInitiatedAt: null, printedAt: null } } : {}),
      ...cursorWhere(decodeCursor(q.cursor))
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    include: { document: true }
  });
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: page.map((o) => orderListItem(o)),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined
  };
}
