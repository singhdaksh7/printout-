import { cx } from '../cx';
import './status.css';

export interface ProgressBarProps {
  /** 0-100. Only use for real progress (uploads, printing); use Skeleton for layout that is still loading. */
  value: number;
  /** Required accessible name, e.g. "Printing 4822". */
  label: string;
  tone?: 'default' | 'warn';
  size?: 'sm' | 'md';
  onDark?: boolean;
  className?: string;
}

export function ProgressBar({ value, label, tone = 'default', size = 'md', onDark, className }: ProgressBarProps) {
  const v = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      className={cx('pb-progress', size === 'sm' && 'pb-progress--sm', tone === 'warn' && 'pb-progress--warn', onDark && 'pb-progress--on-dark', className)}
    >
      <span className="pb-progress__fill" style={{ width: `${v}%` }} />
    </span>
  );
}
