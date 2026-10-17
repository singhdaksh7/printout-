import type { AfterHoursPolicy, ShopSettings } from '@prisma/client';
import { AppError } from '../errors.js';
import { addDays, blocksOrders, evaluateAvailability, localYmd, parseStoredHours, todayView, type Availability } from './hours.js';

type Row = Pick<ShopSettings, 'timezone' | 'operatingHours' | 'specialClosures' | 'temporaryClosure' | 'reopenUntil' | 'afterHoursPolicy'>;

/** Customer-safe availability computed on the server from authoritative settings. */
export function publicAvailability(row: Row | null | undefined, now: Date = new Date()) {
  const cfg = parseStoredHours(row);
  const policy: AfterHoursPolicy = row?.afterHoursPolicy ?? 'ACCEPT';
  const a = evaluateAvailability(cfg, now);
  const horizon = localYmd(cfg.timezone, now.getTime());
  const limit = addDays(horizon, 60);
  return {
    serverTime: now.toISOString(),
    timezone: cfg.timezone,
    ...a,
    // Whether NEW customer orders are currently rejected because the shop is closed (afterHoursPolicy = BLOCK).
    orderingBlocked: blocksOrders(policy, a),
    afterHoursPolicy: policy,
    today: todayView(cfg, now),
    weeklyHours: cfg.operatingHours,
    upcomingClosures: cfg.specialClosures.filter((c) => c.date >= horizon && c.date <= limit).sort((x, y) => x.date.localeCompare(y.date)),
    temporaryClosure: a.reason === 'temporary_closure' ? { reason: cfg.temporaryClosure?.reason ?? null, until: cfg.temporaryClosure?.until ?? null } : null
  };
}

/** Throws SHOP_CLOSED when the shop is closed and its policy blocks new orders. */
export function assertAcceptingByHours(row: Row | null | undefined, now: Date = new Date()): Availability {
  const cfg = parseStoredHours(row);
  const a = evaluateAvailability(cfg, now);
  if (blocksOrders(row?.afterHoursPolicy ?? 'ACCEPT', a)) {
    throw new AppError(409, 'SHOP_CLOSED', 'This shop is closed and is not taking new orders right now', { nextOpenAt: a.nextOpenAt, reason: a.reason });
  }
  return a;
}
