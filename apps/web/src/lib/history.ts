/**
 * Order-history helpers. The shop's documented day convention is Asia/Kolkata (fixed UTC+05:30, no DST), the same one the API
 * uses for `from`/`to`, so presets and displayed times never depend on the browser's own timezone.
 */
const IST_OFFSET_MS = 5.5 * 3600e3;
const DAY_MS = 86_400e3;
export const HISTORY_MAX_RANGE_DAYS = 93;

export type HistoryPreset = 'today' | 'yesterday' | 'last7' | 'custom';

/** YYYY-MM-DD in Asia/Kolkata for an instant. */
export const istYmd = (at: Date | number = Date.now()): string => new Date(new Date(at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const ymdToDay = (ymd: string): number => Date.parse(`${ymd}T00:00:00Z`);
export const addDays = (ymd: string, days: number): string => new Date(ymdToDay(ymd) + days * DAY_MS).toISOString().slice(0, 10);
const isRealYmd = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(ymdToDay(v)) && new Date(ymdToDay(v)).toISOString().slice(0, 10) === v;

/** Inclusive IST date range for a preset. `custom` is resolved by the caller. */
export function presetRange(preset: Exclude<HistoryPreset, 'custom'>, now: Date | number = Date.now()): { from: string; to: string } {
  const today = istYmd(now);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'yesterday') { const y = addDays(today, -1); return { from: y, to: y }; }
  return { from: addDays(today, -6), to: today };
}

/** A user-readable problem with a custom range, or null when it is valid. Mirrors the API rules. */
export function rangeError(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both a start and an end date.';
  if (!isRealYmd(from) || !isRealYmd(to)) return 'Enter valid dates.';
  if (to < from) return 'The end date must not be before the start date.';
  if ((ymdToDay(to) - ymdToDay(from)) / DAY_MS + 1 > HISTORY_MAX_RANGE_DAYS) return `Choose a range of at most ${HISTORY_MAX_RANGE_DAYS} days.`;
  return null;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const timeSecFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });

export const istTime = (iso: string): string => timeFmt.format(new Date(iso));
export const istTimeSeconds = (iso: string): string => timeSecFmt.format(new Date(iso));
export const istDate = (iso: string): string => dateFmt.format(new Date(iso));
/** "11:44" for single-day views, "10 Mar, 11:44" when the range spans several days. */
export const istStamp = (iso: string, withDate: boolean): string => (withDate ? `${istDate(iso)}, ${istTime(iso)}` : istTime(iso));

/** Human range label: "Today", "Yesterday", "Last 7 days" or "10 Mar to 16 Mar". */
export function rangeLabel(preset: HistoryPreset, from: string, to: string): string {
  if (preset === 'today') return 'Today';
  if (preset === 'yesterday') return 'Yesterday';
  if (preset === 'last7') return 'Last 7 days';
  if (!isRealYmd(from) || !isRealYmd(to)) return 'Custom range'; // a half-typed date must never crash the page
  const d = (ymd: string) => dateFmt.format(new Date(`${ymd}T12:00:00Z`));
  return from === to ? d(from) : `${d(from)} to ${d(to)}`;
}

/** Status filter options. Wording follows ORDER_STATUS_DISPLAY: nothing here claims paper was confirmed. */
export const HISTORY_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'NEW', label: 'New' },
  { value: 'ACCEPTED,PRINTING', label: 'Print started' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'PRINTED,READY,COLLECTED', label: 'Legacy (confirmed / collected)' }
];
