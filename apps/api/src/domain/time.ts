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
