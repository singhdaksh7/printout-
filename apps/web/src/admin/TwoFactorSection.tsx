import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import {
  acknowledgeRecoveryCodes,
  confirmTwoFactorEnrollment,
  disableTwoFactor,
  fmtDate,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  startTwoFactorEnrollment,
  type TwoFactorEnrollment,
  type TwoFactorStatus
} from '../lib/admin-api';
import { Banner, Button, Card, CardHeader, Checkbox, KeyValueList, TextField } from '../ui';
import { FormError, PasswordField, useFocusAfterBusy } from './account-parts';
import { LoadError, Loading, useLoad } from './ui';

const MIN_RECOVERY_WARN = 3;

/** Maps an API failure to a field message (focus goes to that field) or a form-level message. */
function mapError(e: unknown): { field?: 'current' | 'code'; message: string; restart?: boolean; reload?: boolean } {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CURRENT_PASSWORD') return { field: 'current', message: 'Current password is incorrect.' };
    if (e.code === 'INVALID_TWO_FACTOR_CODE') return { field: 'code', message: 'That code is not valid. Wait for the next code in your app and try again.' };
    if (e.code === 'NO_PENDING_ENROLLMENT') return { message: 'This setup expired. Start again.', restart: true };
    if (e.code === 'TWO_FACTOR_ALREADY_ENABLED' || e.code === 'TWO_FACTOR_NOT_ENABLED') return { message: 'Your two-step verification status changed. Reloading.', reload: true };
    if (e.code === 'TWO_FACTOR_UNAVAILABLE') return { message: 'Two-step verification is unavailable on this server right now. Contact the platform operator.' };
    if (e.status === 429 || e.code === 'RATE_LIMITED') return { message: 'Too many attempts. Wait a few minutes before trying again.' };
    if (e.code === 'NETWORK_ERROR') return { message: e.message };
    if (e.status >= 500) return { message: 'The server had a problem. Nothing was changed. Please try again shortly.' };
  }
  return { message: 'Something went wrong. Please try again.' };
}

type Flow =
  | { name: 'idle' }
  | { name: 'enroll-password' }
  | { name: 'enroll-scan'; enrollment: TwoFactorEnrollment }
  | { name: 'codes'; codes: string[]; reason: 'enrolled' | 'regenerated' }
  | { name: 'regenerate' }
  | { name: 'disable' };

function QrImage({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => { if (alive) setSrc(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [uri]);
  if (!src) return <p className="pb-muted">Preparing the QR code…</p>;
  return <img className="ad-qr" src={src} width={200} height={200} alt="QR code for adding Printout Buddy to your authenticator app" />;
}

/** Copy-to-clipboard with a visible, announced result. Falls back to a message when the clipboard is unavailable. */
function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={async () => {
          try { await navigator.clipboard.writeText(text); setState('ok'); } catch { setState('fail'); }
        }}
      >
        {label}
      </Button>
      <span role="status" className="pb-muted ad-copystatus">{state === 'ok' ? done : state === 'fail' ? 'Copy is not available here. Select the text and copy it.' : ''}</span>
    </>
  );
}

function RecoveryCodes({ codes, reason, onDone }: { codes: string[]; reason: 'enrolled' | 'regenerated'; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const text = codes.join('\n');

  function download() {
    const blob = new Blob([`Printout Buddy admin recovery codes\nEach code works once. Keep this file somewhere safe and private.\n\n${text}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'printout-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await acknowledgeRecoveryCodes();
      onDone();
    } catch (e) {
      setError(mapError(e).message);
      setBusy(false);
    }
  }

  return (
    <Card as="section" aria-labelledby="ad-codes-title">
      <div className="ad-form">
        <CardHeader id="ad-codes-title" title={reason === 'enrolled' ? 'Two-step verification is on' : 'New recovery codes'} />
        <h3 ref={headingRef} tabIndex={-1} className="pb-h3">Save your recovery codes now</h3>
        <Banner tone="warn">
          These codes are shown only once. Each one signs you in a single time if you lose your phone. Store them in a password manager or print them and keep them somewhere safe. Never email or message them.
          {reason === 'regenerated' ? ' Your previous codes no longer work.' : ''}
        </Banner>
        <ol className="ad-codes" aria-label="Recovery codes">
          {codes.map((c) => <li key={c}><code>{c}</code></li>)}
        </ol>
        <div className="ad-actions">
          <CopyButton text={text} label="Copy all codes" done="Recovery codes copied." />
          <Button type="button" variant="outline" size="sm" onClick={download}>Download as text file</Button>
        </div>
        <FormError message={error} />
        <Checkbox label="I have saved these recovery codes in a safe place" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={busy} />
        <div className="ad-actions"><Button type="button" variant="primary" disabled={!saved} loading={busy} onClick={finish}>Done</Button></div>
      </div>
    </Card>
  );
}

/** Password (+ optional code) re-authentication form shared by enroll / regenerate / disable. */
function ReauthForm({
  id, title, intro, needsCode, allowRecovery, submitLabel, busyLabel, destructive, onCancel, onSubmit
}: {
  id: string; title: string; intro: string; needsCode: boolean; allowRecovery?: boolean; submitLabel: string; busyLabel: string; destructive?: boolean;
  onCancel: () => void;
  onSubmit: (v: { currentPassword: string; code: string; method: 'totp' | 'recovery' }) => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const [errors, setErrors] = useState<{ current?: string; code?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const focusWhenIdle = useFocusAfterBusy(busy);
  useEffect(() => { currentRef.current?.focus(); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found: { current?: string; code?: string } = {};
    if (!current) found.current = 'Enter your current password.';
    if (needsCode && !code.trim()) found.code = method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes.';
    setErrors(found);
    setFormError(null);
    if (found.current) return void currentRef.current?.focus();
    if (found.code) return void codeRef.current?.focus();
    setBusy(true);
    try {
      await onSubmit({ currentPassword: current, code: code.trim(), method });
    } catch (err) {
      const m = mapError(err);
      if (m.field === 'current') { setErrors({ current: m.message }); setCurrent(''); focusWhenIdle(currentRef.current); }
      else if (m.field === 'code') { setErrors({ code: m.message }); setCode(''); focusWhenIdle(codeRef.current); }
      else setFormError(m.message);
      setBusy(false);
    }
  }

  return (
    <Card as="section" aria-labelledby={id}>
      <form onSubmit={submit} noValidate className="ad-form" aria-labelledby={id}>
        <CardHeader id={id} title={title} />
        <p className="pb-muted">{intro}</p>
        <FormError message={formError} />
        <PasswordField ref={currentRef} label="Current password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setErrors((x) => ({ ...x, current: undefined })); }} error={errors.current} disabled={busy} required />
        {needsCode && (
          <TextField
            ref={codeRef}
            key={method}
            label={method === 'totp' ? 'Authentication code' : 'Recovery code'}
            inputMode={method === 'totp' ? 'numeric' : 'text'}
            autoComplete="off"
            spellCheck={false}
            maxLength={method === 'totp' ? 7 : 14}
            mono
            helperText={method === 'totp' ? 'The 6-digit code from your authenticator app. If you just used it to sign in, wait for the next one.' : 'Format: XXXXX-XXXXX. The code is used up.'}
            value={code}
            onChange={(e) => { setCode(method === 'totp' ? e.target.value.replace(/[^0-9 ]/g, '') : e.target.value.toUpperCase()); setErrors((x) => ({ ...x, code: undefined })); }}
            error={errors.code}
            disabled={busy}
            required
          />
        )}
        <div className="ad-actions">
          <Button type="submit" variant={destructive ? 'danger' : 'primary'} loading={busy}>{busy ? busyLabel : submitLabel}</Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          {needsCode && allowRecovery && (
            <Button type="button" variant="ghost" onClick={() => { setMethod((m) => (m === 'totp' ? 'recovery' : 'totp')); setCode(''); setErrors({}); }} disabled={busy}>
              {method === 'totp' ? 'Use a recovery code instead' : 'Use my authenticator app instead'}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

function EnrollScan({ enrollment, onConfirmed, onCancel }: { enrollment: TwoFactorEnrollment; onConfirmed: (codes: string[]) => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const focusWhenIdle = useFocusAfterBusy(busy);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    if (!code.trim()) { setError('Enter the 6-digit code shown in your authenticator app.'); codeRef.current?.focus(); return; }
    setBusy(true);
    try {
      const done = await confirmTwoFactorEnrollment({ code: code.trim() });
      onConfirmed(done.recoveryCodes);
    } catch (err) {
      const m = mapError(err);
      if (m.field === 'code') { setError(m.message); setCode(''); focusWhenIdle(codeRef.current); }
      else if (m.restart) onCancel();
      else setFormError(m.message);
      setBusy(false);
    }
  }

  return (
    <Card as="section" aria-labelledby="ad-scan-title">
      <form onSubmit={submit} noValidate className="ad-form" aria-labelledby="ad-scan-title">
        <CardHeader id="ad-scan-title" title="Set up your authenticator app" />
        <ol className="ad-steps">
          <li>Open an authenticator app (such as Google Authenticator, Microsoft Authenticator, 1Password or Authy) and add a new account.</li>
          <li>Scan this QR code with the app.</li>
        </ol>
        <div className="ad-scan"><QrImage uri={enrollment.otpauthUri} /></div>
        <details className="ad-manual">
          <summary>Can't scan? Enter the setup key by hand</summary>
          <p className="pb-muted">Choose “time-based” and enter this key. Account: {enrollment.accountName}.</p>
          <p className="ad-secret" aria-label="Setup key">{enrollment.manualKey}</p>
          <CopyButton text={enrollment.manualKey.replace(/ /g, '')} label="Copy setup key" done="Setup key copied." />
        </details>
        <ol className="ad-steps" start={3}>
          <li>Enter the 6-digit code the app now shows. Two-step verification is only switched on after the code is verified.</li>
        </ol>
        <FormError message={formError} />
        <TextField
          ref={codeRef}
          label="Authentication code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          mono
          value={code}
          onChange={(e) => { setCode(e.target.value.replace(/[^0-9 ]/g, '')); setError(null); }}
          error={error}
          disabled={busy}
          required
        />
        <div className="ad-actions">
          <Button type="submit" variant="primary" loading={busy}>{busy ? 'Verifying…' : 'Verify and turn on'}</Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

export default function TwoFactorSection({ recoveryUsed }: { recoveryUsed?: number | undefined }) {
  const { data, error, loading, reload } = useLoad((s) => getTwoFactorStatus(s), []);
  const [flow, setFlow] = useState<Flow>({ name: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);

  const finish = (message?: string) => { setFlow({ name: 'idle' }); if (message) setNotice(message); reload(); };

  if (loading && !data) return <Loading label="Loading security settings" />;
  if (error != null && !data) return <LoadError error={error} onRetry={reload} />;
  if (!data) return null;
  const status: TwoFactorStatus = data;

  if (flow.name === 'enroll-password') {
    return (
      <ReauthForm
        id="ad-enroll-title"
        title="Turn on two-step verification"
        intro="First confirm it is you. Then you will scan a QR code with an authenticator app on your phone."
        needsCode={false}
        submitLabel="Continue"
        busyLabel="Checking…"
        onCancel={() => setFlow({ name: 'idle' })}
        onSubmit={async ({ currentPassword }) => {
          const enrollment = await startTwoFactorEnrollment({ currentPassword });
          setFlow({ name: 'enroll-scan', enrollment });
        }}
      />
    );
  }
  if (flow.name === 'enroll-scan') {
    return <EnrollScan enrollment={flow.enrollment} onCancel={() => setFlow({ name: 'idle' })} onConfirmed={(codes) => setFlow({ name: 'codes', codes, reason: 'enrolled' })} />;
  }
  if (flow.name === 'codes') {
    return <RecoveryCodes codes={flow.codes} reason={flow.reason} onDone={() => finish(flow.reason === 'enrolled' ? 'Two-step verification is on. You will be asked for a code each time you sign in.' : 'New recovery codes saved. The old codes no longer work.')} />;
  }
  if (flow.name === 'regenerate') {
    return (
      <ReauthForm
        id="ad-regen-title"
        title="Get new recovery codes"
        intro="This replaces all of your recovery codes; the old ones stop working immediately. Confirm with your password and a current code from your authenticator app."
        needsCode
        submitLabel="Generate new codes"
        busyLabel="Generating…"
        onCancel={() => setFlow({ name: 'idle' })}
        onSubmit={async ({ currentPassword, code }) => {
          const done = await regenerateRecoveryCodes({ currentPassword, code });
          setFlow({ name: 'codes', codes: done.recoveryCodes, reason: 'regenerated' });
        }}
      />
    );
  }
  if (flow.name === 'disable') {
    return (
      <ReauthForm
        id="ad-disable-title"
        title="Turn off two-step verification"
        intro="Your account will be protected by your password alone, and your other signed-in devices will be signed out. Confirm with your password and a code."
        needsCode
        allowRecovery
        destructive
        submitLabel="Turn off two-step verification"
        busyLabel="Turning off…"
        onCancel={() => setFlow({ name: 'idle' })}
        onSubmit={async ({ currentPassword, code, method }) => {
          await disableTwoFactor({ currentPassword, code, method });
          finish('Two-step verification is off.');
        }}
      />
    );
  }

  const low = status.enabled && status.recoveryCodesRemaining <= MIN_RECOVERY_WARN;
  return (
    <Card as="section" aria-labelledby="ad-security-title">
      <div className="ad-form">
        <CardHeader id="ad-security-title" title="Two-step verification" />
        {recoveryUsed !== undefined && (
          <Banner tone="warn">You signed in with a recovery code. {recoveryUsed} recovery code{recoveryUsed === 1 ? '' : 's'} left. If your phone is lost or replaced, set up your authenticator app again and get new codes.</Banner>
        )}
        {notice && <div role="status"><Banner tone="ok">{notice}</Banner></div>}
        {!status.available ? (
          <Banner tone="info">Two-step verification is not available on this server yet. The platform operator needs to configure it first (see the operator guide).</Banner>
        ) : status.enabled ? (
          <>
            <p className="pb-muted">Sign-in needs your password and a code from your authenticator app.</p>
            <KeyValueList items={[
              { label: 'Status', value: 'On' },
              { label: 'Turned on', value: fmtDate(status.enrolledAt) },
              { label: 'Recovery codes left', value: String(status.recoveryCodesRemaining) }
            ]} />
            {low && <Banner tone="warn">You have {status.recoveryCodesRemaining === 0 ? 'no' : 'few'} recovery codes left. Get new ones so you can still sign in if you lose your phone.</Banner>}
            {!status.recoveryCodesAcknowledged && !low && <Banner tone="warn">You have not confirmed that you saved your recovery codes. Get new codes and store them safely.</Banner>}
            <div className="ad-actions">
              <Button type="button" variant="outline" onClick={() => { setNotice(null); setFlow({ name: 'regenerate' }); }}>Get new recovery codes</Button>
              <Button type="button" variant="outline" onClick={() => { setNotice(null); setFlow({ name: 'disable' }); }}>Turn off</Button>
            </div>
          </>
        ) : (
          <>
            <p className="pb-muted">Add a second step to admin sign-in: a 6-digit code from an authenticator app on your phone. Strongly recommended for platform admin accounts.</p>
            <KeyValueList items={[{ label: 'Status', value: 'Off' }]} />
            <div className="ad-actions"><Button type="button" variant="primary" onClick={() => { setNotice(null); setFlow({ name: 'enroll-password' }); }}>Set up two-step verification</Button></div>
          </>
        )}
      </div>
    </Card>
  );
}
