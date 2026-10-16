import type { ReactNode } from 'react';
import { cx } from '../cx';
import './layout.css';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Render the value in the mono font (IDs, codes, hashes). */
  mono?: boolean;
}

export interface KeyValueListProps {
  items: ReadonlyArray<KeyValueItem>;
  /** `inline`: label and value side by side (job details). `stacked`: label above value (profile cards on narrow widths). */
  layout?: 'inline' | 'stacked';
  className?: string;
}

/** Description list for label/value pairs: Copies, Colour, Pages, Sides, Paper, Printer, Estimate. */
export function KeyValueList({ items, layout = 'inline', className }: KeyValueListProps) {
  return (
    <dl className={cx('pb-kv', `pb-kv--${layout}`, className)}>
      {items.map((it, i) => (
        <div key={i} className="pb-kv__row">
          <dt className="pb-kv__label">{it.label}</dt>
          <dd className={cx('pb-kv__value', it.mono && 'pb-mono')}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
