import { useId, type ReactNode } from 'react';
import { cx } from '../cx';
import { Icon } from '../icons/Icon';
import './inputs.css';

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  /** Right-aligned tag/chip, e.g. a status chip or "Pro". */
  tag?: ReactNode;
  disabled?: boolean;
  /** Not available on the current plan: disabled, with a lock icon. Explain why in `description`. */
  locked?: boolean;
}

export interface RadioGroupProps<T extends string> {
  legend: string;
  hideLegend?: boolean;
  options: ReadonlyArray<RadioOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  name?: string;
  /** `list`: bordered rows (cancel reasons). `card`: larger choice cards (printer choice). */
  variant?: 'list' | 'card';
  error?: string | null | undefined;
  className?: string;
}

/**
 * Single choice from a few options, as a fieldset of native radios (arrow keys move the selection).
 * Locked options render disabled with a lock icon and are never selectable.
 */
export function RadioGroup<T extends string>({ legend, hideLegend, options, value, onChange, name, variant = 'list', error, className }: RadioGroupProps<T>) {
  const auto = useId();
  const group = name ?? `pb-radio-${auto}`;
  const errId = `${group}-error`;
  return (
    <fieldset className={cx('pb-radiogroup', `pb-radiogroup--${variant}`, className)} aria-describedby={error ? errId : undefined} aria-invalid={error ? true : undefined}>
      <legend className={cx('pb-field__label', hideLegend && 'pb-sr-only')}>{legend}</legend>
      {options.map((o) => {
        const disabled = o.disabled || o.locked;
        return (
          <label key={o.value} className={cx('pb-choice', o.locked && 'pb-choice--locked', disabled && 'is-disabled')}>
            {o.locked ? <Icon name="lock" size={18} className="pb-choice__lock" /> : null}
            <input type="radio" name={group} value={o.value} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} />
            <span className="pb-choice__body">
              <span className="pb-choice__label">{o.label}{o.locked && <span className="pb-sr-only"> (locked)</span>}</span>
              {o.description && <span className="pb-choice__desc">{o.description}</span>}
            </span>
            {o.tag && <span className="pb-choice__tag">{o.tag}</span>}
          </label>
        );
      })}
      {error && <p id={errId} className="pb-field__error" role="alert">{error}</p>}
    </fieldset>
  );
}
