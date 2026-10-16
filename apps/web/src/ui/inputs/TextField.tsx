import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import { describedBy, FieldFrame, useFieldIds } from './FieldFrame';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  label: string;
  helperText?: ReactNode;
  /** Error message. Sets aria-invalid and replaces the helper text. */
  error?: string | null | undefined;
  /** Static text/icon before the value, e.g. "₹" or "+91". */
  startAdornment?: ReactNode;
  endAdornment?: ReactNode;
  /** Mono font for codes and IDs. */
  mono?: boolean;
  /** Keep the label for assistive tech but hide it visually (e.g. a search box with a visible icon). */
  hideLabel?: boolean;
  density?: 'md' | 'compact';
  wrapperClassName?: string;
}

/** Labelled text input (text, email, password, number, tel, search). Forwards its ref to the native input. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, helperText, error, startAdornment, endAdornment, mono, hideLabel, density = 'md', id: idProp, className, wrapperClassName, disabled, readOnly, type = 'text', 'aria-describedby': described, ...rest },
  ref
) {
  const { id, helpId, errorId } = useFieldIds(idProp);
  return (
    <FieldFrame id={id} helpId={helpId} errorId={errorId} label={label} hideLabel={hideLabel} helperText={helperText} error={error} className={wrapperClassName}>
      <div className={cx('pb-control', density === 'compact' && 'pb-control--compact', error && 'pb-control--invalid', disabled && 'pb-control--disabled', readOnly && 'pb-control--readonly')}>
        {startAdornment && <span className="pb-control__adorn">{startAdornment}</span>}
        <input
          ref={ref}
          id={id}
          type={type}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(described, error ? errorId : helperText ? helpId : null)}
          className={cx('pb-control__input', mono && 'pb-mono', className)}
          {...rest}
        />
        {endAdornment && <span className="pb-control__adorn">{endAdornment}</span>}
      </div>
    </FieldFrame>
  );
});
