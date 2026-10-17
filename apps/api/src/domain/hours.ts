import { z } from 'zod';

/**
 * Shop operating hours: pure, timezone-aware availability calculation. See docs/SHOP_HOURS.md for the semantics.
 *
 * - A weekly schedule maps each weekday to intervals {start, end} ("HH:MM", end may be "24:00").
 * - An interval belongs to the local calendar day it STARTS on. end < start means it crosses midnight
 *   (21:00-02:00 is open 21:00 -> 02:00 next day). start === end is invalid. 00:00-24:00 is a 24-hour day.
 * - A special closure closes the WHOLE local calendar date (including the tail of the previous day's overnight interval).
 * - A temporary closure overrides the schedule until `until` (or until the shopkeeper clears it).
 * - An emergency reopen (`reopenUntil`) overrides everything above until that instant.
 * - No schedule configured => availability is "unknown" (never claimed open), unless a closure is active.
 */

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];
export interface Interval { start: string; end: string }
export type WeeklyHours = Record<Day, Interval[]>;
export interface SpecialClosure { date: string; reason?: string | null }
export interface TemporaryClosure { reason?: string | null; startedAt: string; until?: string | null }

export const MAX_INTERVALS_PER_DAY = 6;
export const MAX_SPECIAL_CLOSURES = 366;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_TIME = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const minutes = (t: string): number => {
  if (t === '24:00') return 1440;
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
};

const isRealDate = (ymd: string): boolean => {
  if (!YMD.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const p = new Date(Date.UTC(y, m - 1, d));
  return p.getUTCFullYear() === y && p.getUTCMonth() === m - 1 && p.getUTCDate() === d;
};

const intervalSchema = z
  .object({ start: z.string().regex(TIME, 'Use HH:MM (24-hour)'), end: z.string().regex(END_TIME, 'Use HH:MM (24-hour)') })
  .strict();

/** Minute-of-week arcs of an interval set, split at the week boundary so overlap checks are linear. */
function weekSegments(week: WeeklyHours): { day: Day; s: number; e: number }[] {
  const segs: { day: Day; s: number; e: number }[] = [];
  DAYS.forEach((day, i) => {
    for (const iv of week[day]) {
      const s = i * 1440 + minutes(iv.start);
      let e = i * 1440 + minutes(iv.end);
      if (e <= i * 1440 + minutes(iv.start)) e += 1440; // overnight (start === end is rejected earlier)
      if (e > 10080) {
        segs.push({ day, s, e: 10080 });
        segs.push({ day, s: 0, e: e - 10080 });
      } else segs.push({ day, s, e });
    }
  });
  return segs;
}

export const weeklyHoursSchema = z
  .object(Object.fromEntries(DAYS.map((d) => [d, z.array(intervalSchema).max(MAX_INTERVALS_PER_DAY)])) as Record<Day, z.ZodArray<typeof intervalSchema>>)
  .strict()
  .superRefine((week, ctx) => {
    let bad = false;
    for (const day of DAYS) {
      week[day].forEach((iv, idx) => {
        if (iv.start === iv.end) { bad = true; ctx.addIssue({ code: 'custom', path: [day, idx, 'end'], message: 'Closing time must differ from opening time' }); }
        if (iv.end === '24:00' && iv.start === '00:00' && week[day].length > 1) { bad = true; ctx.addIssue({ code: 'custom', path: [day, idx, 'end'], message: 'A 24-hour day cannot have other intervals' }); }
      });
    }
    if (bad) return;
    const segs = weekSegments(week as WeeklyHours).sort((a, b) => a.s - b.s);
    for (let i = 1; i < segs.length; i++) {
      if (segs[i]!.s < segs[i - 1]!.e) {
        ctx.addIssue({ code: 'custom', path: [segs[i]!.day], message: 'Opening intervals overlap' });
        return;
      }
    }
  });

export const specialClosuresSchema = z
  .array(
    z
      .object({
        date: z.string().refine(isRealDate, 'Use a real date (YYYY-MM-DD)'),
        reason: z.string().trim().max(100).nullable().optional()
      })
      .strict()
  )
  .max(MAX_SPECIAL_CLOSURES)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((c, i) => {
      if (seen.has(c.date)) ctx.addIssue({ code: 'custom', path: [i, 'date'], message: 'Duplicate closure date' });
      seen.add(c.date);
    });
  });

// ---- timezone arithmetic ---------------------------------------------------------------------------------------
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of `tz` from UTC at instant `t`. */
function offsetAt(tz: string, t: number): number {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** UTC instant of local wall time `ymd` + `minuteOfDay` in `tz` (minuteOfDay may be 1440 = next midnight). Gap times resolve forward. */
export function localToUtc(tz: string, ymd: string, minuteOfDay: number): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  let guess = naive - offsetAt(tz, naive);
  guess = naive - offsetAt(tz, guess);
  return guess;
}

export function localYmd(tz: string, t: number): string {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export const addDays = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export const dayOf = (ymd: string): Day => DAYS[(new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7]!;

// ---- availability ----------------------------------------------------------------------------------------------
export interface HoursConfig {
  timezone: string;
  operatingHours: WeeklyHours | null;
  specialClosures: SpecialClosure[];
  temporaryClosure: TemporaryClosure | null;
  reopenUntil: Date | null;
}

export type AvailabilityReason =
  | 'schedule'
  | 'outside_hours'
  | 'special_closure'
  | 'temporary_closure'
  | 'emergency_reopen'
  | 'not_configured';

export interface Availability {
  state: 'open' | 'closed' | 'unknown';
  reason: AvailabilityReason;
  /** Closure reason text entered by the shopkeeper (special/temporary closure). */
  closureReason: string | null;
  /** Instant the current open spell ends (open only; null if it cannot be determined). */
  closesAt: string | null;
  /** Next instant the shop opens (closed only; null when it cannot be calculated). */
  nextOpenAt: string | null;
}

interface Span { s: number; e: number }
const HORIZON_DAYS = 21;

/** Absolute open spans (UTC ms) for local dates [from, from+days), closures removed, touching spans merged. */
function openSpans(cfg: HoursConfig, fromYmd: string, days: number): Span[] {
  const week = cfg.operatingHours;
  if (!week) return [];
  const spans: Span[] = [];
  for (let i = 0; i < days; i++) {
    const ymd = addDays(fromYmd, i);
    for (const iv of week[dayOf(ymd)]) {
      const sm = minutes(iv.start);
      const em = minutes(iv.end);
      const s = localToUtc(cfg.timezone, ymd, sm);
      const e = em > sm ? localToUtc(cfg.timezone, ymd, em) : localToUtc(cfg.timezone, ymd, em + 1440);
      spans.push({ s, e });
    }
  }
  let result = spans.sort((a, b) => a.s - b.s);
  for (const c of cfg.specialClosures) {
    const cs = localToUtc(cfg.timezone, c.date, 0);
    const ce = localToUtc(cfg.timezone, c.date, 1440);
    result = result.flatMap((sp) => {
      if (sp.e <= cs || sp.s >= ce) return [sp];
      const out: Span[] = [];
      if (sp.s < cs) out.push({ s: sp.s, e: cs });
      if (sp.e > ce) out.push({ s: ce, e: sp.e });
      return out;
    });
  }
  const merged: Span[] = [];
  for (const sp of result.sort((a, b) => a.s - b.s)) {
    const last = merged[merged.length - 1];
    if (last && sp.s <= last.e) last.e = Math.max(last.e, sp.e);
    else merged.push({ ...sp });
  }
  return merged;
}

const iso = (t: number): string => new Date(t).toISOString();

export function evaluateAvailability(cfg: HoursConfig, now: Date = new Date()): Availability {
  const t = now.getTime();
  const base = { closureReason: null, closesAt: null, nextOpenAt: null };

  if (cfg.reopenUntil && cfg.reopenUntil.getTime() > t) {
    return { ...base, state: 'open', reason: 'emergency_reopen', closesAt: cfg.reopenUntil.toISOString() };
  }

  const today = localYmd(cfg.timezone, t);
  const spans = openSpans(cfg, addDays(today, -1), HORIZON_DAYS + 1);
  const nextSpanAfter = (from: number): Span | undefined => spans.find((sp) => sp.e > from);

  const tc = cfg.temporaryClosure;
  const tcUntil = tc?.until ? Date.parse(tc.until) : null;
  if (tc && (tcUntil === null || tcUntil > t)) {
    let next: number | null = null;
    if (tcUntil !== null) {
      const sp = nextSpanAfter(tcUntil);
      // No schedule: the closure simply lapses at `until` (availability then unknown).
      next = cfg.operatingHours ? (sp ? Math.max(sp.s, tcUntil) : null) : tcUntil;
    }
    return { state: 'closed', reason: 'temporary_closure', closureReason: tc.reason || null, closesAt: null, nextOpenAt: next === null ? null : iso(next) };
  }

  const closure = cfg.specialClosures.find((c) => c.date === today);
  if (!cfg.operatingHours) {
    if (closure) {
      const nextDay = addDays(today, 1);
      const stillClosed = (d: string) => cfg.specialClosures.some((c) => c.date === d);
      return { ...base, state: 'closed', reason: 'special_closure', closureReason: closure.reason || null, nextOpenAt: stillClosed(nextDay) ? null : iso(localToUtc(cfg.timezone, nextDay, 0)) };
    }
    return { ...base, state: 'unknown', reason: 'not_configured' };
  }

  const current = spans.find((sp) => sp.s <= t && t < sp.e);
  if (current) return { ...base, state: 'open', reason: 'schedule', closesAt: iso(current.e) };
  const next = spans.find((sp) => sp.s > t);
  return {
    ...base,
    state: 'closed',
    reason: closure ? 'special_closure' : 'outside_hours',
    closureReason: closure?.reason || null,
    nextOpenAt: next ? iso(next.s) : null
  };
}

/** Does the shop's ordering policy reject a NEW customer order right now? */
export const blocksOrders = (policy: 'ACCEPT' | 'BLOCK', a: Availability): boolean => policy === 'BLOCK' && a.state === 'closed';

export interface TodayView { date: string; day: Day; closedAllDay: boolean; reason: string | null; intervals: Interval[] }

export function todayView(cfg: HoursConfig, now: Date = new Date()): TodayView | null {
  if (!cfg.operatingHours) return null;
  const date = localYmd(cfg.timezone, now.getTime());
  const day = dayOf(date);
  const closure = cfg.specialClosures.find((c) => c.date === date);
  return { date, day, closedAllDay: !!closure || cfg.operatingHours[day].length === 0, reason: closure?.reason || null, intervals: closure ? [] : cfg.operatingHours[day] };
}

/** Normalise stored JSON (possibly absent/legacy) into a typed config. Corrupt data degrades to "no schedule". */
export function parseStoredHours(row: {
  timezone?: string | null;
  operatingHours?: unknown;
  specialClosures?: unknown;
  temporaryClosure?: unknown;
  reopenUntil?: Date | null;
} | null | undefined): HoursConfig {
  const tz = row?.timezone && isValidTimezone(row.timezone) ? row.timezone : 'Asia/Kolkata';
  const hours = weeklyHoursSchema.safeParse(row?.operatingHours);
  const closures = specialClosuresSchema.safeParse(row?.specialClosures ?? []);
  const tc = row?.temporaryClosure as TemporaryClosure | null | undefined;
  return {
    timezone: tz,
    operatingHours: hours.success ? (hours.data as WeeklyHours) : null,
    specialClosures: closures.success ? closures.data : [],
    temporaryClosure: tc && typeof tc === 'object' && typeof tc.startedAt === 'string' ? tc : null,
    reopenUntil: row?.reopenUntil ?? null
  };
}

export const emptyWeek = (): WeeklyHours => ({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] });
