/**
 * Retention wording helpers. The server owns the retention policy (`retentionMinutes`); the UI only
 * words it. DEFAULT_RETENTION_MINUTES is a DISPLAY-ONLY fallback used when an older API omits the
 * field. It never affects any deadline: countdowns always use the server's `deleteAfter`.
 */
export const DEFAULT_RETENTION_MINUTES = 30;

export function resolveRetentionMinutes(minutes?: number | null): number {
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_RETENTION_MINUTES;
}
/** "30 minutes" / "1 minute" */
export function retentionPhrase(minutes?: number | null): string {
  const m = resolveRetentionMinutes(minutes);
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}
/** "30-minute" */
export function retentionHyphen(minutes?: number | null): string {
  return `${resolveRetentionMinutes(minutes)}-minute`;
}
