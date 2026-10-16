import { cx } from '../cx';
import './status.css';

export interface SpinnerProps {
  /** Pixel size. Default 20. */
  size?: number;
  /** Accessible name. Without it the spinner is decorative (hidden from assistive tech). */
  label?: string;
  className?: string;
}

/** Indeterminate activity indicator. Per the design system it is used only inside the control that was pressed. */
export function Spinner({ size = 20, label, className }: SpinnerProps) {
  return (
    <span
      className={cx('pb-spinner', className)}
      style={{ width: size, height: size }}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}
