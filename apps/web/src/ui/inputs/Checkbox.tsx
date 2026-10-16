import { forwardRef, useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import { describedBy, useFieldIds } from './FieldFrame';
import './inputs.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label: ReactNode;
  hint?: ReactNode;
  /** Mixed state for a "select all" box. Purely visual/ARIA; you still control `checked`. */
  indeterminate?: boolean;
}

/** Native checkbox with a 44px row, visible label and optional hint. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, indeterminate, id: idProp, className, 'aria-describedby': described, ...rest },
  ref
) {
  const { id, helpId } = useFieldIds(idProp);
  const inner = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <div className={cx('pb-check', className)}>
      <input
        ref={(el) => {
          inner.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        id={id}
        type="checkbox"
        aria-describedby={describedBy(described, hint ? helpId : null)}
        {...rest}
      />
      <label htmlFor={id} className="pb-check__label">{label}</label>
      {hint && <p id={helpId} className="pb-check__hint">{hint}</p>}
    </div>
  );
});
