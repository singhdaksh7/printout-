import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from '../cx';
import { Icon } from '../icons/Icon';
import { describedBy, FieldFrame, useFieldIds } from './FieldFrame';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label: string;
  helperText?: ReactNode;
  error?: string | null | undefined;
  hideLabel?: boolean;
  wrapperClassName?: string;
}

/** Labelled native select (printer, status, city, plan filters). Options are plain `<option>` children. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, helperText, error, hideLabel, id: idProp, className, wrapperClassName, disabled, children, 'aria-describedby': described, ...rest },
  ref
) {
  const { id, helpId, errorId } = useFieldIds(idProp);
  return (
    <FieldFrame id={id} helpId={helpId} errorId={errorId} label={label} hideLabel={hideLabel} helperText={helperText} error={error} className={wrapperClassName}>
      <div className={cx('pb-control', 'pb-control--select', error && 'pb-control--invalid', disabled && 'pb-control--disabled')}>
        <select
          ref={ref}
          id={id}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(described, error ? errorId : helperText ? helpId : null)}
          className={cx('pb-control__input', className)}
          {...rest}
        >
          {children}
        </select>
        <Icon name="chevron-down" size={18} className="pb-control__chevron" />
      </div>
    </FieldFrame>
  );
});
