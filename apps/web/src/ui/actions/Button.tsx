import { forwardRef, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { cx } from '../cx';
import { Icon, type IconName } from '../icons/Icon';
import { Spinner } from '../status/Spinner';
import './actions.css';

export type ButtonVariant = 'primary' | 'dark' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string | undefined;
}

/** Class string for non-button elements that must look like a Button (e.g. a router `<Link>`). */
export function buttonClass({ variant = 'outline', size = 'md', fullWidth, className }: ButtonStyleOptions = {}): string {
  return cx('pb-btn', `pb-btn--${variant}`, `pb-btn--${size}`, fullWidth && 'pb-btn--block', className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Omit<ButtonStyleOptions, 'className'> {
  /** Shows a spinner, keeps the width and label, and ignores activation (click, Enter, Space, form submit). */
  loading?: boolean;
  iconStart?: IconName;
  iconEnd?: IconName;
}

/**
 * Design system button. One `primary` (orange, navy label) per screen; `dark` for row actions such as Print.
 * `type` defaults to "button" so a Button never submits a form by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, fullWidth, loading = false, iconStart, iconEnd, className, children, onClick, type = 'button', disabled, ...rest },
  ref
) {
  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    if (loading) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  }
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, fullWidth, className: cx(loading && 'pb-btn--loading', className) })}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={handleClick}
      {...rest}
    >
      {iconStart && <Icon name={iconStart} size={18} />}
      <span className="pb-btn__label">{children}</span>
      {iconEnd && <Icon name={iconEnd} size={18} />}
      {loading && <Spinner className="pb-btn__spinner" size={18} />}
    </button>
  );
});
