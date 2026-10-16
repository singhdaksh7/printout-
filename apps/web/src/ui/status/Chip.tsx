import type { HTMLAttributes } from 'react';
import { cx } from '../cx';
import './status.css';

export type ChipTone = 'neutral' | 'info' | 'orange' | 'ok' | 'warn' | 'err';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  size?: 'sm' | 'md';
  /** Leading status dot (all printed status chips have one). */
  dot?: boolean;
}

/**
 * Non-interactive status chip. Always renders a span with visible text: colour is a second signal, never the only one.
 * Domain statuses (print job, device, subscription) map to a tone in ../domain, not here.
 */
export function Chip({ tone = 'neutral', size = 'md', dot = true, className, children, ...rest }: ChipProps) {
  return (
    <span className={cx('pb-chip', `pb-chip--${tone}`, size === 'sm' && 'pb-chip--sm', className)} {...rest}>
      {dot && <span className="pb-chip__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
