import { forwardRef, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cx } from '../cx';
import { describedBy, FieldFrame, useFieldIds } from './FieldFrame';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  helperText?: ReactNode;
  error?: string | null | undefined;
  mono?: boolean;
  hideLabel?: boolean;
  wrapperClassName?: string;
}

/** Labelled multi-line input (notes, reasons). Same label/help/error behaviour as TextField. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, helperText, error, mono, hideLabel, id: idProp, className, wrapperClassName, disabled, readOnly, rows = 3, 'aria-describedby': described, ...rest },
  ref
) {
  const { id, helpId, errorId } = useFieldIds(idProp);
  return (
    <FieldFrame id={id} helpId={helpId} errorId={errorId} label={label} hideLabel={hideLabel} helperText={helperText} error={error} className={wrapperClassName}>
      <div className={cx('pb-control', 'pb-control--multiline', error && 'pb-control--invalid', disabled && 'pb-control--disabled', readOnly && 'pb-control--readonly')}>
        <textarea
          ref={ref}
          id={id}
          rows={rows}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(described, error ? errorId : helperText ? helpId : null)}
          className={cx('pb-control__input', mono && 'pb-mono', className)}
          {...rest}
        />
      </div>
    </FieldFrame>
  );
});
