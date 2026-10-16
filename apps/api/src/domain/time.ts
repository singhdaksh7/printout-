/** Asia/Kolkata is a fixed UTC+05:30 offset (no DST), so day boundaries are simple arithmetic. */
const IST_OFFSET_MS = 5.5 * 3600e3;
const DAY_MS = 86_400e3;

export function startOfIstDay(now = new Date()): Date {
  const shifted = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

export function endOfIstDay(now = new Date()): Date {
  return new Date(startOfIstDay(now).getTime() + DAY_MS);
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Start (UTC instant) of the Asia/Kolkata calendar day named `ymd` (YYYY-MM-DD), or undefined if it is not a real date. */
export function istDayStartFromYmd(ymd: string): Date | undefined {
  const m = YMD.exec(ymd);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return undefined;
  return new Date(probe.getTime() - IST_OFFSET_MS);
}

/** The Asia/Kolkata calendar date (YYYY-MM-DD) of an instant. */
export function istYmd(at = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
