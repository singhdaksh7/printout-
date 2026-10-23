import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

export const OTP_LENGTH = 6;

interface Props {
  value: string;
  onChange(v: string): void;
  onComplete?(v: string): void;
  disabled?: boolean;
  invalid?: boolean;
  /** Focus the first empty box on mount / when this changes. */
  focusKey?: unknown;
  describedBy?: string;
}

/** Six single-digit boxes behaving like one field: paste fills all, backspace and arrows move, SMS autofill works. */
export function OtpInput({ value, onChange, onComplete, disabled, invalid, focusKey, describedBy }: Props) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] ?? '');

  useEffect(() => {
    if (disabled) return;
    refs.current[Math.min(value.length, OTP_LENGTH - 1)]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, disabled]);

  const focus = (i: number) => refs.current[Math.max(0, Math.min(OTP_LENGTH - 1, i))]?.focus();
  const commit = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, OTP_LENGTH);
    onChange(clean);
    if (clean.length === OTP_LENGTH) onComplete?.(clean);
    return clean;
  };

  function onInput(i: number, raw: string) {
    const typed = raw.replace(/\D/g, '');
    if (!typed) { commit(value.slice(0, i) + value.slice(i + 1)); return; }
    // Autofill / multi-char input arrives as one string: spread it from this box.
    commit(value.slice(0, i) + typed + value.slice(i + 1));
    focus(i + typed.length);
  }
  function onKeyDown(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i]) { e.preventDefault(); if (i > 0) { commit(value.slice(0, i - 1) + value.slice(i)); focus(i - 1); } }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focus(i - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); focus(i + 1); }
    else if (e.key === 'Home') { e.preventDefault(); focus(0); }
    else if (e.key === 'End') { e.preventDefault(); focus(OTP_LENGTH - 1); }
  }
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '');
    if (!text) return;
    e.preventDefault();
    const clean = commit(text);
    focus(clean.length >= OTP_LENGTH ? OTP_LENGTH - 1 : clean.length);
  }

  return (
    <div role="group" aria-label="6-digit verification code" aria-describedby={describedBy} className="pb-otp" data-testid="otp-group">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          className={`pb-otp__box${invalid ? ' pb-otp__box--invalid' : ''}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1} of ${OTP_LENGTH}`}
          aria-invalid={invalid || undefined}
          maxLength={i === 0 ? OTP_LENGTH : 1}
          disabled={disabled}
          value={d}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
