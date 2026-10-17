import { forwardRef, useEffect, useRef, useState } from 'react';
import { Banner, Button, TextField, type TextFieldProps } from '../ui';

/** TextField with a Show/Hide control. The toggle is a real button (keyboard + screen reader friendly), not an icon-only target. */
export const PasswordField = forwardRef<HTMLInputElement, Omit<TextFieldProps, 'type' | 'endAdornment'>>(function PasswordField({ label, disabled, ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      ref={ref}
      label={label}
      type={shown ? 'text' : 'password'}
      disabled={disabled}
      autoCapitalize="none"
      spellCheck={false}
      endAdornment={
        <Button variant="ghost" size="sm" aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`} onClick={() => setShown((v) => !v)} disabled={disabled}>
          {shown ? 'Hide' : 'Show'}
        </Button>
      }
      {...rest}
    />
  );
});

/**
 * Focus that waits for the form to be re-enabled: a field is `disabled` while saving, and a disabled input cannot take
 * focus, so server-side field errors request focus here and it is applied once `busy` has dropped.
 */
export function useFocusAfterBusy(busy: boolean) {
  const target = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!busy && target.current) { target.current.focus(); target.current = null; }
  }, [busy]);
  return (el: HTMLInputElement | null) => { target.current = el; };
}

/** Form-level error region: focused when a non-field error appears so keyboard and screen-reader users land on it. */
export function FormError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (message) ref.current?.focus(); }, [message]);
  return <div ref={ref} tabIndex={-1} className="ad-formerr">{message && <Banner tone="err">{message}</Banner>}</div>;
}

