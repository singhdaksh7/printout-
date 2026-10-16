import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import { describedBy, useFieldIds } from './FieldFrame';
import './inputs.css';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'role'> {
  label: ReactNode;
  hint?: ReactNode;
}

/**
 * On/off setting that takes effect immediately (Sound for new orders). A native checkbox with role="switch", so it keeps
 * keyboard (Space), form and screen-reader behaviour. The state is shown by the thumb position as well as colour.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch({ label, hint, id: idProp, className, 'aria-describedby': described, ...rest }, ref) {
  const { id, helpId } = useFieldIds(idProp);
  return (
    <div className={cx('pb-switch', className)}>
      <input ref={ref} id={id} type="checkbox" role="switch" className="pb-switch__input" aria-describedby={describedBy(described, hint ? helpId : null)} {...rest} />
      <label htmlFor={id} className="pb-switch__label">
        <span className="pb-switch__track" aria-hidden="true"><span className="pb-switch__thumb" /></span>
        <span>{label}</span>
      </label>
      {hint && <p id={helpId} className="pb-switch__hint">{hint}</p>}
    </div>
  );
});
