// Shop operating hours: shared types and formatting. Availability itself is always computed by the API;
// the browser only formats the instants it is given (it never decides open/closed from its own clock).

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];
export const DAY_LABEL: Record<Day, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

export interface Interval { start: string; end: string }
export type WeeklyHours = Record<Day, Interval[]>;
export interface SpecialClosure { date: string; reason?: string | null }
export type AfterHoursPolicy = 'ACCEPT' | 'BLOCK';
export type AvailabilityState = 'open' | 'closed' | 'unknown';
export type AvailabilityReason = 'schedule' | 'outside_hours' | 'special_closure' | 'temporary_closure' | 'emergency_reopen' | 'not_configured';

export interface Availability {
  state: AvailabilityState;
  reason: AvailabilityReason;
  closureReason: string | null;
  closesAt: string | null;
  nextOpenAt: string | null;
  orderingBlocked?: boolean;
  serverTime?: string;
}

export const emptyWeek = (): WeeklyHours => ({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] });

export const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];

/** "09:00" -> "9:00 AM"; "24:00" -> "12:00 AM". */
export function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const hour = h % 24;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(m).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export const isOvernight = (iv: Interval): boolean => iv.end !== '24:00' && iv.end <= iv.start;
export const is24h = (iv: Interval): boolean => iv.start === '00:00' && iv.end === '24:00';

export function describeInterval(iv: Interval): string {
  if (is24h(iv)) return 'Open 24 hours';
  return `${formatClock(iv.start)} – ${formatClock(iv.end)}${isOvernight(iv) ? ' (next day)' : ''}`;
}
export function describeDay(intervals: Interval[]): string {
  return intervals.length === 0 ? 'Closed' : intervals.map(describeInterval).join(', ');
}

/** Format an instant in the shop's timezone, e.g. "Tue 9:00 AM" (just the time when it is the same local day as `ref`). */
export function formatInstant(iso: string, timezone: string, ref?: string): string {
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(d);
  if (ref && day(new Date(ref)) === day(d)) return time;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(d);
  if (ref && d.getTime() - new Date(ref).getTime() < 6 * 86_400_000) return `${weekday} ${time}`;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: timezone, day: 'numeric', month: 'short' }).format(d);
  return `${weekday}, ${date} ${time}`;
}

export function formatDate(ymd: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${ymd}T00:00:00Z`));
}

/** Headline for badges/banners. Times are formatted relative to the server's clock (`serverTime`), never the device's. */
export function availabilityHeadline(a: Availability, timezone: string): { tone: 'ok' | 'err' | 'neutral'; title: string; detail: string | null } {
  const ref = a.serverTime;
  if (a.state === 'open') {
    return { tone: 'ok', title: 'Open now', detail: a.closesAt ? `Closes ${formatInstant(a.closesAt, timezone, ref)}${a.reason === 'emergency_reopen' ? ' (temporary reopening)' : ''}` : null };
  }
  if (a.state === 'closed') {
    const why = a.reason === 'temporary_closure' ? 'Temporarily closed' : a.reason === 'special_closure' ? 'Closed today' : 'Closed now';
    return { tone: 'err', title: why, detail: a.nextOpenAt ? `Opens ${formatInstant(a.nextOpenAt, timezone, ref)}` : null };
  }
  return { tone: 'neutral', title: 'Opening hours not set', detail: null };
}

/** Client-side mirror of the server rules, for instant feedback. The server remains authoritative. */
export function validateWeek(week: WeeklyHours): Partial<Record<Day, string>> {
  const errors: Partial<Record<Day, string>> = {};
  const min = (t: string) => (t === '24:00' ? 1440 : Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
  const segs: { day: Day; s: number; e: number }[] = [];
  DAYS.forEach((day, i) => {
    for (const iv of week[day]) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(iv.start) || !/^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(iv.end)) { errors[day] ??= 'Enter both opening and closing times.'; continue; }
      if (iv.start === iv.end) { errors[day] ??= 'Closing time must differ from opening time.'; continue; }
      const s = i * 1440 + min(iv.start);
      let e = i * 1440 + min(iv.end);
      if (min(iv.end) <= min(iv.start)) e += 1440;
      if (e > 10080) { segs.push({ day, s, e: 10080 }); segs.push({ day, s: 0, e: e - 10080 }); } else segs.push({ day, s, e });
    }
    if (week[day].length > 6) errors[day] ??= 'At most 6 intervals per day.';
  });
  segs.sort((a, b) => a.s - b.s);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i]!.s < segs[i - 1]!.e) errors[segs[i]!.day] ??= 'These hours overlap another interval (check overnight hours from the day before).';
  }
  return errors;
}
