import { useId, type ReactNode } from 'react';
import { cx } from '../cx';
import './inputs.css';

/** Stable ids for a form control and its help/error text. Never derived from the label text. */
export function useFieldIds(idProp?: string) {
  const auto = useId();
  const id = idProp ?? `pb-f${auto.replace(/:/g, '')}`;
  return { id, helpId: `${id}-help`, errorId: `${id}-error` };
}

/** Joins ids for aria-describedby, skipping empties. */
export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const v = ids.filter(Boolean).join(' ');
  return v || undefined;
}

export interface FieldFrameProps {
  id: string;
  helpId: string;
  errorId: string;
  label: string;
  hideLabel?: boolean | undefined;
  helperText?: ReactNode;
  error?: string | null | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/** Shared label + control + helper/error layout for TextField, TextArea and Select. */
export function FieldFrame({ id, helpId, errorId, label, hideLabel, helperText, error, className, children }: FieldFrameProps) {
  return (
    <div className={cx('pb-field', className)}>
      <label htmlFor={id} className={cx('pb-field__label', hideLabel && 'pb-sr-only')}>{label}</label>
      {children}
      {error ? (
        <p id={errorId} className="pb-field__error" role="alert">{error}</p>
      ) : helperText ? (
        <p id={helpId} className="pb-field__help">{helperText}</p>
      ) : null}
    </div>
  );
}
