import { OrderStatus, Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { csvCell, HISTORY_EXPORT_MAX_ROWS, HISTORY_MAX_RANGE_DAYS, resolveHistoryRange, type HistoryRange } from './order-history.js';
import { istYmd } from './time.js';

/**
 * Shopkeeper revenue dashboard (read-only, tenant-scoped).
 *
 * WHAT THE DATABASE CAN SUPPORT: every Order stores `totalPaise`, the price quoted from the shop's rate card at the moment the
 * order was created (immutable snapshot; later rate-card edits never change it). There is NO customer payment, settlement, refund
 * or cost record: cash is settled at the counter, outside the app. The `Payment`/`Invoice` tables are the shop's own subscription
 * billing and say nothing about customer orders. Therefore this module reports ESTIMATED ORDER VALUE only and states explicitly
 * that collected revenue, refunds and net earnings are unavailable. It never labels a quote as money received.
 *
 * Metric rules (all ranges are inclusive Asia/Kolkata calendar days, bucketed by Order.createdAt):
 * - Order count: every order created in the range, any status.
 * - Counted orders: orders that are not CANCELLED or EXPIRED. Estimated order value, pages and the average use only these.
 * - Estimated order value: SUM(totalPaise) over counted orders, integer paise (BigInt in SQL, never floating point).
 * - Pages requested: SUM(selectedPageCount x copies) over counted orders; orders with no recorded page count are reported
 *   separately as `ordersWithUnknownPages` and contribute 0 pages (never guessed).
 * - Print started: orders whose document has a print-initiated (or legacy printed) timestamp. Not proof paper came out.
 * - Average estimated order value: round(value / counted orders), null when there are no counted orders.
 * Every figure on the page, the chart, the breakdowns and the CSV derives from the same grouped rows or the same filters.
 */
export const REVENUE_MAX_RANGE_DAYS = HISTORY_MAX_RANGE_DAYS;
export const REVENUE_EXPORT_MAX_ROWS = HISTORY_EXPORT_MAX_ROWS;
const DAY_MS = 86_400e3;
const IST_OFFSET_MS = 5.5 * 3600e3;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
/** Strict: unknown keys (including `shopId`) are rejected. The tenant always comes from the session. */
export const revenueQuery = z.object({ from: ymd.optional(), to: ymd.optional() }).strict();
export type RevenueQuery = z.infer<typeof revenueQuery>;

export const resolveRevenueRange = (q: RevenueQuery, now = new Date()): HistoryRange => resolveHistoryRange(q, now);

const NOT_COUNTED: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.EXPIRED];
const UNKNOWN = 'unknown';

interface AggRow {
  day: string;
  status: OrderStatus;
  colour: string;
  sides: string;
  paper: string;
  started: boolean;
  orders: number;
  value: bigint;
  pages: bigint;
  unknownPages: number;
  zero: number;
}

/** One grouped, bounded query (at most days x statuses x variants rows). `shopId` is a bound parameter, never interpolated. */
async function aggregate(prisma: PrismaClient, shopId: string, from: Date, to: Date): Promise<AggRow[]> {
  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
      o."status" AS status,
      COALESCE(o."printOptionsSnapshot"->>'colourMode', ${UNKNOWN}) AS colour,
      COALESCE(o."printOptionsSnapshot"->>'sides', ${UNKNOWN}) AS sides,
      COALESCE(o."printOptionsSnapshot"->>'paperSize', ${UNKNOWN}) AS paper,
      (d."printInitiatedAt" IS NOT NULL OR d."printedAt" IS NOT NULL) AS started,
      COUNT(*)::int AS orders,
      COALESCE(SUM(o."totalPaise"), 0)::bigint AS value,
      COALESCE(SUM(
        CASE WHEN o."priceSnapshot"->>'selectedPageCount' ~ '^[0-9]{1,9}$'
          THEN (o."priceSnapshot"->>'selectedPageCount')::bigint *
               (CASE WHEN o."printOptionsSnapshot"->>'copies' ~ '^[0-9]{1,6}$' THEN (o."printOptionsSnapshot"->>'copies')::bigint ELSE 1 END)
          ELSE 0 END), 0)::bigint AS pages,
      COUNT(*) FILTER (WHERE NOT (o."priceSnapshot"->>'selectedPageCount' ~ '^[0-9]{1,9}$') OR o."priceSnapshot"->>'selectedPageCount' IS NULL)::int AS "unknownPages",
      COUNT(*) FILTER (WHERE o."totalPaise" = 0)::int AS zero
    FROM "Order" o
    JOIN "Document" d ON d."id" = o."documentId"
    WHERE o."shopId" = ${shopId} AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
    GROUP BY 1, 2, 3, 4, 5, 6`);
}

export interface Bucket {
  key: string;
  orders: number;
  valuePaise: number;
  pages: number;
}

export interface RevenueTotals {
  orderCount: number;
  countedOrders: number;
  estimatedOrderValuePaise: number;
  averageEstimatedOrderValuePaise: number | null;
  pagesRequested: number;
  ordersWithUnknownPages: number;
  zeroValueOrders: number;
  printStarted: number;
  cancelled: number;
  expired: number;
  /** Quoted value of cancelled/expired orders. Shown for transparency, never part of estimated order value. */
  excludedQuotedValuePaise: number;
}

const bucketsOf = (m: Map<string, Bucket>): Bucket[] => [...m.values()].sort((a, b) => b.valuePaise - a.valuePaise || b.orders - a.orders || a.key.localeCompare(b.key));
function add(m: Map<string, Bucket>, key: string, r: AggRow) {
  const b = m.get(key) ?? { key, orders: 0, valuePaise: 0, pages: 0 };
  b.orders += r.orders;
  b.valuePaise += Number(r.value);
  b.pages += Number(r.pages);
  m.set(key, b);
}

function totalsOf(rows: AggRow[]): RevenueTotals {
  const t: RevenueTotals = {
    orderCount: 0, countedOrders: 0, estimatedOrderValuePaise: 0, averageEstimatedOrderValuePaise: null, pagesRequested: 0,
    ordersWithUnknownPages: 0, zeroValueOrders: 0, printStarted: 0, cancelled: 0, expired: 0, excludedQuotedValuePaise: 0
  };
  for (const r of rows) {
    t.orderCount += r.orders;
    if (r.started) t.printStarted += r.orders;
    if (r.status === OrderStatus.CANCELLED) t.cancelled += r.orders;
    if (r.status === OrderStatus.EXPIRED) t.expired += r.orders;
    if (NOT_COUNTED.includes(r.status)) {
      t.excludedQuotedValuePaise += Number(r.value);
      continue;
    }
    t.countedOrders += r.orders;
    t.estimatedOrderValuePaise += Number(r.value);
    t.pagesRequested += Number(r.pages);
    t.ordersWithUnknownPages += r.unknownPages;
    t.zeroValueOrders += r.zero;
  }
  if (t.countedOrders > 0) t.averageEstimatedOrderValuePaise = Math.round(t.estimatedOrderValuePaise / t.countedOrders);
  return t;
}

const dayRange = (fromYmd: string, toYmd: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${fromYmd}T00:00:00Z`); t <= Date.parse(`${toYmd}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

export interface DailyPoint {
  date: string;
  orders: number;
  countedOrders: number;
  estimatedOrderValuePaise: number;
  pagesRequested: number;
}

function dailyOf(rows: AggRow[], range: HistoryRange): DailyPoint[] {
  const by = new Map(dayRange(range.fromYmd, range.toYmd).map((d) => [d, { date: d, orders: 0, countedOrders: 0, estimatedOrderValuePaise: 0, pagesRequested: 0 } as DailyPoint]));
  for (const r of rows) {
    const p = by.get(r.day);
    if (!p) continue;
    p.orders += r.orders;
    if (NOT_COUNTED.includes(r.status)) continue;
    p.countedOrders += r.orders;
    p.estimatedOrderValuePaise += Number(r.value);
    p.pagesRequested += Number(r.pages);
  }
  return [...by.values()];
}

function breakdownOf(rows: AggRow[]) {
  const colour = new Map<string, Bucket>();
  const sides = new Map<string, Bucket>();
  const paper = new Map<string, Bucket>();
  const status = new Map<string, Bucket>();
  for (const r of rows) {
    add(status, r.status, r);
    if (NOT_COUNTED.includes(r.status)) continue;
    add(colour, r.colour, r);
    add(sides, r.sides, r);
    add(paper, r.paper, r);
  }
  const statusOrder = Object.values(OrderStatus);
  return {
    colourMode: bucketsOf(colour),
    sides: bucketsOf(sides),
    paperSize: bucketsOf(paper),
    status: statusOrder.map((s) => status.get(s) ?? { key: s, orders: 0, valuePaise: 0, pages: 0 })
  };
}

/** Percentage change to one decimal, or null when the baseline is zero (never invent growth from nothing). */
export function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) * 1000) / previous) / 10;
}

/** The equally long window that ends the day before `range` starts. */
export function previousRange(range: HistoryRange): { fromYmd: string; toYmd: string; from: Date; to: Date } {
  const days = Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS);
  const from = new Date(range.from.getTime() - days * DAY_MS);
  const to = range.from;
  return { fromYmd: istYmd(from), toYmd: istYmd(new Date(to.getTime() - 1)), from, to };
}

export async function revenueReport(prisma: PrismaClient, shopId: string, range: HistoryRange) {
  const prev = previousRange(range);
  const [rows, prevRows, first] = await Promise.all([
    aggregate(prisma, shopId, range.from, range.to),
    aggregate(prisma, shopId, prev.from, prev.to),
    prisma.order.findFirst({ where: { shopId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  ]);
  const totals = totalsOf(rows);
  const prevTotals = totalsOf(prevRows);
  // Comparison is only meaningful when the shop already existed for the whole previous window and it had orders.
  const reason = prevTotals.orderCount === 0 ? 'NO_PREVIOUS_ORDERS' : !first || first.createdAt > prev.from ? 'PREVIOUS_PERIOD_INCOMPLETE' : null;
  const changes = (reason
    ? { estimatedOrderValue: null, orderCount: null, pagesRequested: null }
    : {
        estimatedOrderValue: pctChange(totals.estimatedOrderValuePaise, prevTotals.estimatedOrderValuePaise),
        orderCount: pctChange(totals.orderCount, prevTotals.orderCount),
        pagesRequested: pctChange(totals.pagesRequested, prevTotals.pagesRequested)
      });
  return {
    timezone: 'Asia/Kolkata',
    range: { from: range.fromYmd, to: range.toYmd, days: dayRange(range.fromYmd, range.toYmd).length },
    basis: 'ESTIMATED_ORDER_VALUE' as const,
    /** Customer payments are not recorded by Printout Buddy; these stay unavailable until a verified payment source exists. */
    collected: { available: false as const, reason: 'NO_CUSTOMER_PAYMENT_RECORDS' },
    totals,
    daily: dailyOf(rows, range),
    breakdown: breakdownOf(rows),
    comparison: {
      previousRange: { from: prev.fromYmd, to: prev.toYmd },
      available: reason === null,
      reason,
      previous: prevTotals,
      changePct: changes
    }
  };
}

// ---- CSV -----------------------------------------------------------------------------------------------------
export const REVENUE_CSV_HEADER = [
  'Created (IST)', 'Job code', 'Status', 'Pages per copy', 'Copies', 'Pages requested', 'Colour', 'Sides', 'Paper',
  'Print started (IST)', 'Counted in estimate', 'Estimated order value (INR)'
] as const;

/** Integer paise -> "12.50". No floating point. */
export const paiseToInr = (paise: number): string => `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
const istStamp = (d: Date | null): string => (d ? new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ') : '');

/**
 * Per-order export for the same range, filters and counting rules as the dashboard. No file names, customer references, storage keys or URLs.
 * Cancelled/expired rows are listed with `Counted in estimate = No` so the column sums to the dashboard figure.
 */
export async function buildRevenueCsv(prisma: PrismaClient, shopId: string, range: HistoryRange) {
  const lines = [REVENUE_CSV_HEADER.map(csvCell).join(',')];
  let after: { createdAt: Date; id: string } | undefined;
  let exported = 0;
  let truncated = false;
  for (;;) {
    const take = Math.min(500, REVENUE_EXPORT_MAX_ROWS - exported);
    const batch = await prisma.order.findMany({
      where: {
        shopId,
        createdAt: { gte: range.from, lt: range.to },
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {})
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: { id: true, orderNumber: true, status: true, createdAt: true, totalPaise: true, priceSnapshot: true, printOptionsSnapshot: true, document: { select: { printInitiatedAt: true, printedAt: true } } }
    });
    const page = batch.slice(0, take);
    for (const o of page) {
      const opts = o.printOptionsSnapshot as { copies?: number; colourMode?: string; sides?: string; paperSize?: string };
      const per = (o.priceSnapshot as { selectedPageCount?: number }).selectedPageCount;
      const perCopy = typeof per === 'number' && Number.isInteger(per) ? per : null;
      const copies = typeof opts.copies === 'number' ? opts.copies : 1;
      lines.push(
        [
          istStamp(o.createdAt), o.orderNumber, o.status, perCopy, opts.copies ?? '', perCopy === null ? '' : perCopy * copies, opts.colourMode ?? '', opts.sides ?? '', opts.paperSize ?? '',
          istStamp(o.document.printInitiatedAt ?? o.document.printedAt), NOT_COUNTED.includes(o.status) ? 'No' : 'Yes', paiseToInr(o.totalPaise)
        ].map(csvCell).join(',')
      );
    }
    exported += page.length;
    const last = page.at(-1);
    if (batch.length > take) {
      if (exported >= REVENUE_EXPORT_MAX_ROWS) truncated = true;
      else if (last) after = { createdAt: last.createdAt, id: last.id };
    }
    if (batch.length <= take || truncated) break;
  }
  return { csv: `﻿${lines.join('\r\n')}\r\n`, rows: exported, truncated };
}
