import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  countriesFor, createPhoneAuth, maskPhone, normalizePhone, phoneErrorMessage, type PhoneAuthProvider
} from '../lib/phone-auth';
import { Banner, Button, Select, TextField } from '../ui';
import { OTP_LENGTH, OtpInput } from './OtpInput';

export const MAX_RESENDS = 3;

export interface Classified { message: string; /** true = the Firebase code/token is spent or refused: start over from the number. */ restart: boolean }

interface Props {
  allowedCallingCodes: string[];
  defaultCallingCode: string;
  resendCooldownSeconds: number;
  /** Receives the Firebase ID token. Throwing shows `classify(error)`; success ends the flow (parent navigates). */
  onToken(idToken: string): Promise<void>;
  classify(error: unknown): Classified;
  verifyLabel?: string;
  verifyingLabel?: string;
  onStep?(step: 'phone' | 'code', maskedPhone: string | null): void;
  /** Lets the parent show its own message above the form (e.g. "not linked" with a link). */
  notice?: ReactNode;
  idPrefix?: string;
}

/** The two phone-verification screens (number -> code), shared by sign-in and the Settings link flow. */
export function PhoneVerifier({
  allowedCallingCodes, defaultCallingCode, resendCooldownSeconds, onToken, classify, verifyLabel = 'Verify OTP', verifyingLabel = 'Verifying…', onStep, notice, idPrefix = 'pv'
}: Props) {
  const countries = countriesFor(allowedCallingCodes);
  const [callingCode, setCallingCode] = useState(countries.find((c) => c.code === defaultCallingCode)?.code ?? countries[0]!.code);
  const [national, setNational] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [e164, setE164] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState<null | 'send' | 'verify'>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [resends, setResends] = useState(0);
  const [focusKey, setFocusKey] = useState(0);
  const providerRef = useRef<PhoneAuthProvider | null>(null);
  const tokenRef = useRef<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const verifying = useRef(false);

  useEffect(() => { alive.current = true; return () => { alive.current = false; providerRef.current?.reset(); }; }, []);
  useEffect(() => { onStep?.(step, step === 'code' ? maskPhone(e164) : null); }, [step, e164, onStep]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const provider = useCallback(async () => (providerRef.current ??= await createPhoneAuth()), []);

  async function send(number: string, isResend: boolean) {
    setBusy('send'); setError(null);
    try {
      const p = await provider();
      p.reset();
      await p.sendCode(number);
      if (!alive.current) return;
      tokenRef.current = null;
      setE164(number); setOtp(''); setStep('code'); setCooldown(resendCooldownSeconds); setFocusKey((k) => k + 1);
      if (isResend) setResends((n) => n + 1);
    } catch (e) {
      if (alive.current) setError(phoneErrorMessage(e));
    } finally { if (alive.current) setBusy(null); }
  }

  function submitPhone(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const country = countries.find((c) => c.code === callingCode)!;
    const check = normalizePhone(country, national);
    if (!check.ok) { setFieldError(check.message); phoneRef.current?.focus(); return; }
    setFieldError(null);
    void send(check.e164, false);
  }

  async function verify(code: string) {
    if (verifying.current || busy) return;
    if (code.length !== OTP_LENGTH) { setError('Enter the 6-digit code from the SMS.'); return; }
    verifying.current = true;
    setBusy('verify'); setError(null);
    try {
      if (!tokenRef.current) tokenRef.current = await (await provider()).confirm(code);
      await onToken(tokenRef.current);
    } catch (e) {
      if (!alive.current) return;
      const c = e && typeof (e as { status?: unknown }).status === 'number' ? classify(e) : null;
      if (c) {
        setError(c.message);
        if (c.restart) { tokenRef.current = null; providerRef.current?.reset(); setStep('phone'); setOtp(''); }
      } else {
        const msg = phoneErrorMessage(e);
        setError(msg);
        const kind = (e as { kind?: string }).kind;
        // A refused / expired code cannot be retried: clear the boxes (expired needs a new SMS), keep the number.
        setOtp('');
        if (kind === 'code-expired') setCooldown(0);
        setFocusKey((k) => k + 1);
      }
    } finally {
      verifying.current = false;
      if (alive.current) setBusy(null);
    }
  }

  function changeNumber() {
    providerRef.current?.reset();
    tokenRef.current = null;
    setStep('phone'); setOtp(''); setError(null); setCooldown(0); setResends(0);
    setTimeout(() => phoneRef.current?.focus(), 0);
  }

  const resendLeft = MAX_RESENDS - resends;
  const country = countries.find((c) => c.code === callingCode)!;

  return (
    <>
      <div id="pb-recaptcha" />
      {notice}
      <div role="status" aria-live="polite" className="pb-sr-only" data-testid="otp-live">
        {step === 'code' ? `Code sent to ${maskPhone(e164)}.` : ''}
      </div>
      {error && <Banner tone="err"><span data-testid="phone-error">{error}</span></Banner>}
      {step === 'phone' ? (
        <form onSubmit={submitPhone} noValidate className="pb-login__form" aria-label="Phone number">
          <div className="pb-phone-row">
            <Select label="Country code" value={callingCode} onChange={(e) => { setCallingCode(e.target.value); setFieldError(null); }} disabled={!!busy} wrapperClassName="pb-phone-row__cc">
              {countries.map((c) => <option key={c.code} value={c.code}>{`${c.flag} ${c.name} (${c.code})`}</option>)}
            </Select>
            <TextField
              ref={phoneRef}
              id={`${idPrefix}-phone`}
              label="Mobile number"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              startAdornment={<span aria-hidden="true">{country.code}</span>}
              placeholder={country.code === '+91' ? '98765 43210' : ''}
              value={national}
              error={fieldError}
              onChange={(e) => { setNational(e.target.value); setFieldError(null); setError(null); }}
              disabled={!!busy}
              wrapperClassName="pb-phone-row__num"
              autoFocus
            />
          </div>
          <Button type="submit" variant="primary" fullWidth disabled={!!busy || !national.trim()} loading={busy === 'send'}>
            {busy === 'send' ? 'Sending code…' : 'Send OTP'}
          </Button>
          <p className="pb-muted pb-phone-consent">
            By continuing you agree to receive a one-time SMS code to verify this number. Message and data rates may apply. We use your number only to sign you in and never share it.
            {' '}This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.
          </p>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void verify(otp); }} noValidate className="pb-login__form" aria-label="Verification code">
          <p className="pb-muted" id={`${idPrefix}-otp-help`}>
            Enter the 6-digit code we sent to <strong>{maskPhone(e164)}</strong>.
          </p>
          <OtpInput value={otp} onChange={(v) => { setOtp(v); setError(null); }} onComplete={(v) => void verify(v)} disabled={!!busy} invalid={!!error} focusKey={focusKey} describedBy={`${idPrefix}-otp-help`} />
          <Button type="submit" variant="primary" fullWidth disabled={!!busy || otp.length !== OTP_LENGTH} loading={busy === 'verify'}>
            {busy === 'verify' ? verifyingLabel : verifyLabel}
          </Button>
          <div className="pb-phone-actions">
            <Button type="button" variant="ghost" onClick={() => void send(e164, true)} disabled={!!busy || cooldown > 0 || resendLeft <= 0}>
              {cooldown > 0 ? `Resend OTP in ${cooldown}s` : resendLeft <= 0 ? 'No more resends' : 'Resend OTP'}
            </Button>
            <Button type="button" variant="ghost" onClick={changeNumber} disabled={busy === 'verify'}>Change phone number</Button>
          </div>
          {resendLeft <= 0 && <p className="pb-muted pb-phone-consent">You have used all resends. Change the number or try again later.</p>}
        </form>
      )}
    </>
  );
}
