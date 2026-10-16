import { addDays, istYmd, presetRange, rangeError } from './history';

/** Presets for the order-value report. Dates are Asia/Kolkata calendar days, both ends inclusive (same convention as History). */
export type RevenuePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

export function revenueRange(preset: Exclude<RevenuePreset, 'custom'>, now: Date | number = Date.now()): { from: string; to: string } {
  if (preset === 'last30') return { from: addDays(istYmd(now), -29), to: istYmd(now) };
  return presetRange(preset, now);
}
export { rangeError as revenueRangeError };

/** Integer paise -> "₹1,23,456.50" (Indian digit grouping). Integer maths only. */
export function formatInr(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(paise));
  return `${sign}₹${new Intl.NumberFormat('en-IN').format(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

const LABELS: Record<string, string> = { bw: 'Black & white', colour: 'Colour', single: 'Single-sided', duplex: 'Double-sided', unknown: 'Not recorded' };
/** Honest label for a classification key; anything unrecognised is shown as-is, missing data as "Not recorded". */
export const bucketLabel = (key: string): string => LABELS[key] ?? key;

const dm = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
/** "10 Mar" for a YYYY-MM-DD calendar date (no timezone shift: the date is already an IST day). */
export const dayLabel = (ymd: string): string => dm.format(new Date(`${ymd}T00:00:00Z`));

export function rangeText(from: string, to: string): string {
  return from === to ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(to)}`;
}

/** "+12.5%" / "-3%" / "no change". */
export function formatChange(pct: number): string {
  if (pct === 0) return 'no change';
  return `${pct > 0 ? '+' : '-'}${Math.abs(pct)}%`;
}
