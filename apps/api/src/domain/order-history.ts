import { DocumentStatus, OrderStatus, type Document, type Order, type Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { cursorWhere, decodeCursor, encodeCursor } from '../routes/context.js';
import { istDayStartFromYmd, istYmd } from './time.js';
import { parseStatuses } from './order-serializers.js';

/**
 * Shopkeeper order history: a metadata-only, tenant-scoped, date-ranged view over the existing Order model.
 * Nothing here reads object storage or issues document URLs, so a deleted (or live) file's content can never leak through it.
 * "Print initiated" is the server-side signal that Print was pressed; it is never presented as proof that paper came out.
 */
export const HISTORY_MAX_RANGE_DAYS = 93;
export const HISTORY_EXPORT_MAX_ROWS = 5000;
const DAY_MS = 86_400e3;
const IST_OFFSET_MS = 5.5 * 3600e3;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Shared by the list, summary and CSV routes. Dates are Asia/Kolkata calendar days, both ends inclusive. */
const historyFilterShape = {
  from: ymd.optional(),
  to: ymd.optional(),
  /** One status or a comma-separated list. */
  status: z.string().max(200).optional(),
  /** Job code or original file name (case-insensitive, contains). */
  q: z.string().trim().max(100).optional()
};

export const historyListQuery = z
  .object({ ...historyFilterShape, cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();
export const historyFilterQuery = z.object(historyFilterShape).strict();
export type HistoryFilter = z.infer<typeof historyFilterQuery>;
export type HistoryListQuery = z.infer<typeof historyListQuery>;

export interface HistoryRange {
  fromYmd: string;
  toYmd: string;
  /** Inclusive start instant. */
  from: Date;
  /** Exclusive end instant (start of the day after `toYmd`). */
  to: Date;
}

/** No dates = today (IST). One date = that single day. Rejects reversed and over-long ranges. */
export function resolveHistoryRange(q: Pick<HistoryFilter, 'from' | 'to'>, now = new Date()): HistoryRange {
  const today = istYmd(now);
  const fromYmd = q.from ?? q.to ?? today;
  const toYmd = q.to ?? q.from ?? today;
  const from = istDayStartFromYmd(fromYmd);
  const toDay = istDayStartFromYmd(toYmd);
  if (!from || !toDay) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid date');
  if (toDay < from) throw new AppError(400, 'VALIDATION_ERROR', '`to` must not be before `from`');
  const to = new Date(toDay.getTime() + DAY_MS);
  if (to.getTime() - from.getTime() > HISTORY_MAX_RANGE_DAYS * DAY_MS) {
    throw new AppError(400, 'VALIDATION_ERROR', `Range too large (max ${HISTORY_MAX_RANGE_DAYS} days)`);
  }
  return { fromYmd, toYmd, from, to };
}

type WhereOptions = { withStatus?: boolean };

/** Escapes the PostgreSQL LIKE metacharacters (backslash is the default escape character). */
export const escapeLike = (v: string): string => v.replace(/[\\%_]/g, (c) => '\\' + c);

/** Every query starts from `shopId`; callers never pass a tenant. */
export function historyWhere(shopId: string, q: HistoryFilter, range: HistoryRange, opts: WhereOptions = {}): Prisma.OrderWhereInput[] {
  const and: Prisma.OrderWhereInput[] = [{ shopId, createdAt: { gte: range.from, lt: range.to } }];
  const statuses = parseStatuses(q.status);
  if (statuses && opts.withStatus !== false) and.push({ status: { in: statuses } });
  if (q.q) {
    // Prisma does NOT escape LIKE wildcards in `contains`; escape them so "%" or "_" in a search is always literal.
    const term = escapeLike(q.q);
    and.push({
      OR: [
        { orderNumber: { contains: term, mode: 'insensitive' } },
        { document: { originalFilename: { contains: term, mode: 'insensitive' } } }
      ]
    });
  }
  return and;
}

export type HistoryRow = Order & { document: Document };

export interface HistoryItem {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: Date;
  originalFilename: string;
  pageCount: number | null;
  selectedPageCount: number | null;
  copies: number | null;
  colourMode: string | null;
  sides: string | null;
  paperSize: string | null;
  totalPaise: number;
  /** First Print press (or legacy print confirmation). Not proof of physical output. */
  printInitiatedAt: Date | null;
  documentStatus: DocumentStatus;
  fileDeletedAt: Date | null;
  /** Who made the latest status change: a staff display name, a device name, "Automatic" (expiry) or null. */
  handledBy: string | null;
}

interface Snap { copies?: number; colourMode?: string; sides?: string; paperSize?: string }

export function historyItem(o: HistoryRow, handledBy: string | null): HistoryItem {
  const opts = o.printOptionsSnapshot as Snap;
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    createdAt: o.createdAt,
    originalFilename: o.document.originalFilename,
    pageCount: o.document.pageCount,
    selectedPageCount: (o.priceSnapshot as { selectedPageCount?: number }).selectedPageCount ?? null,
    copies: opts.copies ?? null,
    colourMode: opts.colourMode ?? null,
    sides: opts.sides ?? null,
    paperSize: opts.paperSize ?? null,
    totalPaise: o.totalPaise,
    printInitiatedAt: o.document.printInitiatedAt ?? o.document.printedAt,
    documentStatus: o.document.status,
    fileDeletedAt: o.document.status === DocumentStatus.DELETED ? o.document.deletedAt : null,
    handledBy
  };
}

/** Latest status-change actor per order, resolved to a label inside the same shop. */
async function actorLabels(prisma: PrismaClient, shopId: string, rows: HistoryRow[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const histories = await prisma.orderStatusHistory.findMany({
    where: { orderId: { in: ids }, order: { shopId } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { orderId: true, actorUserId: true, actorDeviceId: true }
  });
  const latest = new Map<string, { actorUserId: string | null; actorDeviceId: string | null }>();
  for (const h of histories) if (!latest.has(h.orderId)) latest.set(h.orderId, h);
  const userIds = [...new Set([...latest.values()].map((h) => h.actorUserId).filter((x): x is string => !!x))];
  const deviceIds = [...new Set([...latest.values()].map((h) => h.actorDeviceId).filter((x): x is string => !!x))];
  const [users, devices] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, shopId }, select: { id: true, displayName: true } }) : [],
    deviceIds.length ? prisma.shopDevice.findMany({ where: { id: { in: deviceIds }, shopId }, select: { id: true, name: true } }) : []
  ]);
  const userName = new Map(users.map((u) => [u.id, u.displayName]));
  const deviceName = new Map(devices.map((d) => [d.id, d.name]));
  for (const r of rows) {
    const h = latest.get(r.id);
    let label: string | null = null;
    if (h?.actorUserId) label = userName.get(h.actorUserId) ?? 'Shop staff';
    else if (h?.actorDeviceId) label = deviceName.get(h.actorDeviceId) ?? 'Device';
    else if (r.status === OrderStatus.EXPIRED) label = 'Automatic';
    out.set(r.id, label);
  }
  return out;
}

/** Newest first, keyset-paginated by (createdAt, id): the same opaque cursor the queue uses. */
export async function listHistory(prisma: PrismaClient, shopId: string, q: HistoryListQuery, range: HistoryRange) {
  const rows = await prisma.order.findMany({
    where: { AND: [...historyWhere(shopId, q, range), cursorWhere(decodeCursor(q.cursor))] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    include: { document: true }
  });
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const labels = await actorLabels(prisma, shopId, page);
  return {
    range: { from: range.fromYmd, to: range.toYmd, timezone: 'Asia/Kolkata' },
    items: page.map((o) => historyItem(o, labels.get(o.id) ?? null)),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined
  };
}

/** Counts for the range and search term; deliberately NOT narrowed by the status filter so the totals stay a stable overview. */
export async function historySummary(prisma: PrismaClient, shopId: string, q: HistoryFilter, range: HistoryRange) {
  const where: Prisma.OrderWhereInput = { AND: historyWhere(shopId, q, range, { withStatus: false }) };
  const initiated = { OR: [{ printInitiatedAt: { not: null } }, { printedAt: { not: null } }] };
  const [groups, printInitiated, filesDeleted] = await Promise.all([
    prisma.order.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.order.count({ where: { AND: [where, { document: initiated }] } }),
    prisma.order.count({ where: { AND: [where, { document: { status: DocumentStatus.DELETED } }] } })
  ]);
  const byStatus = Object.fromEntries(Object.values(OrderStatus).map((s) => [s, 0])) as Record<OrderStatus, number>;
  let total = 0;
  for (const g of groups) {
    byStatus[g.status] = g._count._all;
    total += g._count._all;
  }
  return { timezone: 'Asia/Kolkata', range: { from: range.fromYmd, to: range.toYmd }, total, byStatus, printInitiated, filesDeleted };
}

// ---- CSV -----------------------------------------------------------------------------------------------------
/**
 * One CSV cell. Spreadsheet formula injection: a cell whose first non-space character is = + - @ TAB or CR is prefixed with
 * an apostrophe so Excel / Sheets / LibreOffice treat it as text. Every cell is quoted and quotes are doubled.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  s = s.replace(/\r\n|\r|\n/g, ' ');
  if (/^\s*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const CSV_HEADER = [
  'Created (IST)', 'Job code', 'File name', 'Pages in file', 'Pages printed per copy', 'Copies', 'Colour', 'Sides', 'Paper',
  'Status', 'Print initiated (IST)', 'File deleted (IST)', 'Handled by', 'Estimated total (INR)'
] as const;

const istStamp = (d: Date | null): string => (d ? new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ') : '');

export function csvRow(i: HistoryItem): string {
  return [
    istStamp(i.createdAt), i.orderNumber, i.originalFilename, i.pageCount, i.selectedPageCount, i.copies, i.colourMode, i.sides, i.paperSize,
    i.status, istStamp(i.printInitiatedAt), istStamp(i.fileDeletedAt), i.handledBy, (i.totalPaise / 100).toFixed(2)
  ].map(csvCell).join(',');
}

/** Builds the export in 500-row batches up to the cap. `truncated` is true when more rows matched than were exported. */
export async function buildHistoryCsv(prisma: PrismaClient, shopId: string, q: HistoryFilter, range: HistoryRange) {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  let cursor: string | undefined;
  let exported = 0;
  let truncated = false;
  while (exported < HISTORY_EXPORT_MAX_ROWS) {
    const take = Math.min(500, HISTORY_EXPORT_MAX_ROWS - exported);
    const page = await listHistory(prisma, shopId, { ...q, cursor, limit: take }, range);
    for (const item of page.items) lines.push(csvRow(item));
    exported += page.items.length;
    cursor = page.nextCursor;
    if (!cursor) break;
    if (exported >= HISTORY_EXPORT_MAX_ROWS) truncated = true;
  }
  return { csv: `﻿${lines.join('\r\n')}\r\n`, rows: exported, truncated };
}

