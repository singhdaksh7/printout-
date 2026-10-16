import { useId, type ReactNode } from 'react';
import { cx } from '../cx';
import './actions.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional count shown after the label, e.g. "pilot 1". */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group (e.g. "Queue filter"). */
  label: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  name?: string;
  className?: string;
}

/**
 * Single-choice pill track (Active / All today, Today / Yesterday / Last 7 days, status filters with counts).
 * Built on native radio inputs, so Tab enters the group and the arrow keys move and select.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange, size = 'md', name, className }: SegmentedControlProps<T>) {
  const auto = useId();
  const group = name ?? `pb-seg-${auto}`;
  return (
    <div role="radiogroup" aria-label={label} className={cx('pb-seg', `pb-seg--${size}`, className)}>
      {options.map((o) => (
        <label key={o.value} className={cx('pb-seg__opt', o.disabled && 'is-disabled')}>
          <input
            type="radio"
            className="pb-seg__input"
            name={group}
            value={o.value}
            checked={o.value === value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
          />
          <span className="pb-seg__text">
            {o.label}
            {o.count !== undefined && <span className="pb-seg__count pb-tnum">{o.count}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}
