import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import { Icon } from '../icons/Icon';
import { Chip, type ChipProps, type ChipTone } from '../status/Chip';
import './domain.css';

/* Thin product-specific wrappers over the generic primitives. Rule: no data fetching, no business rules; they only
   word and colour values the caller already has. Status vocabulary is the design system's: same chip, same word,
   in every product (docs/design/1.pdf p2). */

// ---- job code -----------------------------------------------------------------------------------------------
export interface JobCodeProps extends HTMLAttributes<HTMLSpanElement> {
  code: string;
  /** `row`: mono, for tables. `display`: Rubik 32 for drawers and the "show this code at the counter" card. */
  size?: 'row' | 'display';
}

export function JobCode({ code, size = 'row', className, ...rest }: JobCodeProps) {
  return <span className={cx('pb-jobcode', `pb-jobcode--${size}`, className)} {...rest}>{code}</span>;
}

// ---- job status ---------------------------------------------------------------------------------------------
export type JobStatusKind = 'queued' | 'printing' | 'printed' | 'failed' | 'expired' | 'cancelled' | 'deleted' | 'paper-out';

export const JOB_STATUS: Record<JobStatusKind, { label: string; tone: ChipTone }> = {
  queued: { label: 'Queued', tone: 'info' },
  printing: { label: 'Printing', tone: 'orange' },
  printed: { label: 'Printed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'err' },
  expired: { label: 'Expired', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  deleted: { label: 'Deleted', tone: 'ok' },
  'paper-out': { label: 'Paper out', tone: 'warn' }
};

export interface JobStatusChipProps extends Omit<ChipProps, 'tone' | 'children'> {
  kind: JobStatusKind;
  /** Override the visible word only when the product genuinely needs different wording. */
  label?: string;
}

export function JobStatusChip({ kind, label, ...rest }: JobStatusChipProps) {
  const s = JOB_STATUS[kind];
  return <Chip tone={s.tone} {...rest}>{label ?? s.label}</Chip>;
}

/**
 * Display adapter for the API's current OrderStatus. Labels are unchanged from the existing shop UI
 * ("Print started", "(legacy)" wording) because the API does not confirm physical printing.
 */
export type LegacyOrderStatus = 'NEW' | 'ACCEPTED' | 'PRINTING' | 'PRINTED' | 'READY' | 'COLLECTED' | 'CANCELLED' | 'EXPIRED';

export const ORDER_STATUS_DISPLAY: Record<LegacyOrderStatus, { label: string; tone: ChipTone }> = {
  NEW: { label: 'New', tone: 'info' },
  ACCEPTED: { label: 'Accepted', tone: 'info' },
  PRINTING: { label: 'Print started', tone: 'orange' },
  PRINTED: { label: 'Print confirmed (legacy)', tone: 'ok' },
  READY: { label: 'Ready (legacy)', tone: 'ok' },
  COLLECTED: { label: 'Collected (legacy)', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' }
};

export function OrderStatusChip({ status, ...rest }: { status: LegacyOrderStatus } & Omit<ChipProps, 'tone' | 'children'>) {
  const s = ORDER_STATUS_DISPLAY[status] ?? { label: String(status), tone: 'neutral' as const };
  return <Chip tone={s.tone} {...rest}>{s.label}</Chip>;
}

// ---- shop, device and subscription status --------------------------------------------------------------------
export const SHOP_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  SUSPENDED: { label: 'Suspended', tone: 'err' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  PILOT: { label: 'Pilot', tone: 'info' },
  PAST_DUE: { label: 'Past due', tone: 'warn' }
};

/** Shop (and subscription) status. Unknown values render neutral with a humanised label. */
export function ShopStatusChip({ status, ...rest }: { status: string } & Omit<ChipProps, 'tone' | 'children'>) {
  const s = SHOP_STATUS[status.toUpperCase()] ?? { label: status.charAt(0).toUpperCase() + status.slice(1).toLowerCase().replace(/_/g, ' '), tone: 'neutral' as const };
  return <Chip tone={s.tone} {...rest}>{s.label}</Chip>;
}

export type PresenceKind = 'online' | 'degraded' | 'offline' | 'ready' | 'paper-out' | 'error' | 'revoked' | 'unknown';

export const PRESENCE: Record<PresenceKind, { label: string; tone: ChipTone }> = {
  online: { label: 'Online', tone: 'ok' },
  ready: { label: 'Ready', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  'paper-out': { label: 'Paper out', tone: 'warn' },
  offline: { label: 'Offline', tone: 'err' },
  error: { label: 'Error', tone: 'err' },
  revoked: { label: 'Disconnected', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' }
};

/** Presence of a device or printer. Pass `label` to add detail ("Offline 4 min"). */
export function PresenceChip({ kind, label, ...rest }: { kind: PresenceKind; label?: string } & Omit<ChipProps, 'tone' | 'children'>) {
  const s = PRESENCE[kind];
  return <Chip tone={s.tone} {...rest}>{label ?? s.label}</Chip>;
}

// ---- retention and deletion ---------------------------------------------------------------------------------
function clock(at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * "Auto-deletes at 12:42" chip. The time must come from the server's deletion deadline (never computed from a
 * hard-coded policy). Renders nothing when there is no deadline.
 */
export function RetentionNotice({ at, prefix = 'Auto-deletes at', size = 'md' }: { at: Date | string | null | undefined; prefix?: string; size?: 'sm' | 'md' }) {
  if (!at) return null;
  const t = clock(at);
  if (!t) return null;
  return <Chip tone="warn" size={size}>{prefix} {t}</Chip>;
}

/** "✓ File deleted 11:31:20" confirmation line under a status chip. `time` is preformatted text from the caller. */
export function FileDeletedLine({ time }: { time: ReactNode }) {
  return (
    <span className="pb-deleted-line">
      <Icon name="check" size={14} />
      File deleted <span className="pb-mono">{time}</span>
    </span>
  );
}
