import type { HTMLAttributes } from 'react';
import { cx } from '../cx';
import './status.css';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'orange' | 'err' | 'warn';
  /** Use on the navy sidebar (e.g. the "Pro" tag). */
  onDark?: boolean;
  /** Small uppercase tag such as SAMPLE. */
  caps?: boolean;
}

/** Compact count or tag: nav counts (orange), "Due" (err), "Pro" (neutral), SAMPLE (warn, caps). */
export function Badge({ tone = 'neutral', onDark, caps, className, ...rest }: BadgeProps) {
  return <span className={cx('pb-badge', `pb-badge--${tone}`, onDark && 'pb-badge--on-dark', caps && 'pb-badge--caps', className)} {...rest} />;
}
