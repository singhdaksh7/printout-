import React, { forwardRef, useId } from 'react';
import './primitives.css';

export type TextFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label: string;
  helperText?: string;
  error?: string;
  density?: 'standard' | 'compact';
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, helperText, error, density = 'standard', className = '',
    'aria-describedby': describedBy, ...rest }, ref,
) {
  const generated = useId();
  const inputId = id ?? `pb-input-${generated}`;
  const helperId = helperText ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const descriptions = [describedBy, helperId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`pb-field pb-field--${density} ${className}`.trim()}>
      <label htmlFor={inputId}>{label}{rest.required ? ' *' : null}</label>
      <input {...rest} id={inputId} ref={ref} aria-invalid={error ? true : undefined}
        aria-describedby={descriptions} className="pb-field__input" />
      {helperText ? <span id={helperId} className="pb-field__helper">{helperText}</span> : null}
      {error ? <span id={errorId} className="pb-field__error" role="alert">{error}</span> : null}
    </div>
  );
});
