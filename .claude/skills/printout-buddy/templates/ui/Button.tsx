import React, { forwardRef } from 'react';
import './primitives.css';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'lg';
export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, fullWidth = false,
    disabled, type = 'button', children, className = '', ...rest }, ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={Boolean(disabled || loading)}
      aria-busy={loading || undefined}
      className={`pb-btn pb-btn--${variant} pb-btn--${size} ${fullWidth ? 'pb-btn--full' : ''} ${className}`.trim()}
    >
      {loading ? <span className="pb-btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
