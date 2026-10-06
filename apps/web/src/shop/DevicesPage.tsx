import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  createPairingCode, describeError, listDevices, renameDevice, revokeDevice,
  type DeviceView, type PairingCode
} from '../lib/shop-api';
import { formatCountdown } from '../lib/format';
import { Banner, Modal, Skeleton, useToast } from './components';
import { ageLabel, useAutoRefresh, useTick } from './hooks';

const PLATFORM_LABEL = { ANDROID: 'Android', WINDOWS: 'Windows' } as const;
const PRESENCE_LABEL = { ONLINE: 'Online', OFFLINE: 'Offline', REVOKED: 'Revoked' } as const;
const dateTime = (iso: string) => new Date(iso).toLocaleString();
const dateOnly = (iso: string) => new Date(iso).toLocaleDateString();

export default function DevicesPage() {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<DeviceView | null>(null);
  const [revoking, setRevoking] = useState<DeviceView | null>(null);
  const { show, node: toast } = useToast();
  // Re-render "Last seen X ago" labels every 30 s.
  useTick(() => Math.floor(Date.now() / 30_000));

  const load = useCallback((silent: boolean) => {
    listDevices().then((r) => { setDevices(r.devices); setLoadError(null); })
      .catch((e) => { if (!silent) setLoadError(describeError(e)); });
  }, []);
  useEffect(() => { load(false); }, [attempt, load]);
  useAutoRefresh(() => load(true), 60_000);

  const replace = (d: DeviceView) => setDevices((list) => (list ? list.map((x) => (x.id === d.id ? d : x)) : list));

  let body;
  if (loadError && !devices) body = <Banner onRetry={() => { setLoadError(null); setAttempt((n) => n + 1); }}>{loadError}</Banner>;
  else if (!devices) body = <Skeleton lines={4} label="Loading devices" />;
  else if (devices.length === 0) {
    body = (
      <div className="sh-card sh-empty" data-testid="devices-empty">
        <h2>No printing devices yet</h2>
        <p>No printing devices yet. Browser printing keeps working; add a device later to print from your phone or PC.</p>
        <button className="sh-btn sh-btn-primary" onClick={() => setAdding(true)}>Add your first device</button>
      </div>
    );
  } else {
    body = (
      <ul className="dev-list" aria-label="Printing devices">
        {devices.map((d) => <DeviceCard key={d.id} d={d} onRename={() => setRenaming(d)} onRevoke={() => setRevoking(d)} />)}
      </ul>
    );
  }

  return (
    <section aria-labelledby="dev-title">
      <Link className="sh-back" to="/shop/settings">‹ Settings</Link>
      <div className="sh-pagehead">
        <h1 id="dev-title">Printing Devices</h1>
        <button className="sh-btn sh-btn-primary" onClick={() => setAdding(true)}>Add device</button>
      </div>
      <p className="sh-muted">Phones and PCs running PrintoutBuddy that can see your orders. Status is based on when each device last checked in; it is not a live connection.</p>
      {loadError && devices && <Banner onRetry={() => load(false)}>{loadError}</Banner>}
      {body}
      {adding && <AddDeviceModal onClose={() => { setAdding(false); load(true); }} />}
      {renaming && <RenameModal device={renaming} onClose={() => setRenaming(null)} onDone={(d) => { replace(d); setRenaming(null); show('Device renamed'); }} />}
      {revoking && <RevokeModal device={revoking} onClose={() => setRevoking(null)} onDone={(d) => { replace(d); setRevoking(null); show('Device disconnected'); }} />}
      {toast}
    </section>
  );
}

function DeviceCard({ d, onRename, onRevoke }: { d: DeviceView; onRename: () => void; onRevoke: () => void }) {
  const revoked = d.status === 'REVOKED' || d.presence === 'REVOKED';
  const presence = revoked ? 'REVOKED' : d.presence;
  return (
    <li className={`sh-card dev-card${revoked ? ' is-revoked' : ''}`} data-testid="device-card">
      <div className="dev-head">
        <h2 className="dev-name sh-wrap">{d.name}</h2>
        <span className="sh-chip dev-platform">{PLATFORM_LABEL[d.platform] ?? d.platform}</span>
        <span className={`sh-chip dev-presence dev-presence-${presence.toLowerCase()}`}>{PRESENCE_LABEL[presence]}</span>
      </div>
      <dl className="dev-meta">
        <div>
          <dt>Last seen</dt>
          <dd title={d.lastSeenAt ? dateTime(d.lastSeenAt) : undefined}>
            {d.lastSeenAt ? `Last seen ${ageLabel(d.lastSeenAt)}` : 'Not seen yet'}
          </dd>
        </div>
        <div><dt>Added</dt><dd title={dateTime(d.createdAt)}>{dateOnly(d.createdAt)}</dd></div>
        {d.appVersion && <div><dt>App version</dt><dd>{d.appVersion}</dd></div>}
        {revoked && d.revokedAt && <div><dt>Disconnected</dt><dd title={dateTime(d.revokedAt)}>{dateOnly(d.revokedAt)}</dd></div>}
      </dl>
      {!revoked && (
        <div className="dev-actions">
          <button className="sh-btn sh-btn-sm" onClick={onRename} aria-label={`Rename ${d.name}`}>Rename</button>
          <button className="sh-btn sh-btn-sm sh-btn-danger" onClick={onRevoke} aria-label={`Disconnect ${d.name}`}>Disconnect</button>
        </div>
      )}
    </li>
  );
}

function RenameModal({ device, onClose, onDone }: { device: DeviceView; onClose: () => void; onDone: (d: DeviceView) => void }) {
  const [name, setName] = useState(device.name);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 60) { setFieldError('Enter a name between 1 and 60 characters.'); return; }
    setFieldError(null); setError(null); setBusy(true);
    try {
      const r = await renameDevice(device.id, trimmed);
      onDone(r.device);
    } catch (err) { setError(describeError(err)); setBusy(false); }
  }
  return (
    <Modal title="Rename device" onClose={onClose} initialFocusRef={input} busy={busy}>
      <form onSubmit={submit} noValidate>
        {error && <Banner>{error}</Banner>}
        <label className="sh-field">
          <span>Device name</span>
          <input ref={input} value={name} maxLength={60} aria-invalid={!!fieldError} onChange={(e) => { setName(e.target.value); setFieldError(null); }} />
          {fieldError && <small className="sh-field-error" role="alert">{fieldError}</small>}
        </label>
        <div className="sh-actions">
          <button className="sh-btn sh-btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save name'}</button>
          <button className="sh-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function RevokeModal({ device, onClose, onDone }: { device: DeviceView; onClose: () => void; onDone: (d: DeviceView) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  async function confirm() {
    if (busy) return;
    setError(null); setBusy(true);
    try { onDone((await revokeDevice(device.id)).device); }
    catch (err) { setError(describeError(err)); setBusy(false); }
  }
  return (
    <Modal title="Disconnect this device?" onClose={onClose} initialFocusRef={cancel} busy={busy}>
      {error && <Banner>{error}</Banner>}
      <p><strong className="sh-wrap">{device.name}</strong> will stop working immediately. It will no longer be able to see your orders or print. To use it again you must add it as a new device.</p>
      <div className="sh-actions">
        <button className="sh-btn sh-btn-danger" onClick={() => void confirm()} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect device'}</button>
        <button ref={cancel} className="sh-btn" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </Modal>
  );
}

/** The raw pairing code lives only in this component's state: never stored, never logged, gone when the modal unmounts. */
function AddDeviceModal({ onClose }: { onClose: () => void }) {
  const [pair, setPair] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expiredNote, setExpiredNote] = useState(false);
  const [copied, setCopied] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(false);
  const mounted = useRef(true);
  const doneBtn = useRef<HTMLButtonElement>(null);

  const generate = useCallback(async () => {
    setLoading(true); setError(null); setCopied(''); setPair(null); setExpiredNote(false);
    try {
      const p = await createPairingCode();
      if (mounted.current) { setPair(p); setNow(Date.now()); }
    } catch (e) { if (mounted.current) setError(describeError(e)); }
    finally { if (mounted.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!started.current) { started.current = true; void generate(); }
    return () => { mounted.current = false; };
  }, [generate]);

  const remaining = pair ? new Date(pair.expiresAt).getTime() - now : 0;
  const expired = !!pair && remaining <= 0;
  useEffect(() => {
    if (!pair) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pair]);
  // An expired code is dropped from memory straight away.
  useEffect(() => { if (expired) { setPair(null); setExpiredNote(true); setCopied(''); } }, [expired]);

  async function copy() {
    if (!pair) return;
    try { await navigator.clipboard.writeText(pair.code); setCopied('Code copied'); }
    catch { setCopied('Could not copy. Select the code and copy it manually.'); }
  }

  return (
    <Modal title="Add a printing device" onClose={onClose} initialFocusRef={doneBtn} busy={loading}>
      {error && <Banner>{error}</Banner>}
      {loading && !pair && <Skeleton lines={2} label="Generating pairing code" />}
      {pair && (
        <div className="dev-code-box">
          <div className="dev-code tnum" data-testid="pairing-code">{pair.code}</div>
          <p className="sh-muted" role="timer">Expires in {formatCountdown(remaining)}</p>
          <button className="sh-btn" onClick={() => void copy()}>Copy code</button>
        </div>
      )}
      {expiredNote && !pair && !loading && <Banner kind="warn">This code has expired. Generate a new one to continue.</Banner>}
      {!pair && !loading && <button className="sh-btn sh-btn-primary" onClick={() => void generate()}>Generate new code</button>}
      <div className="sh-sr-only" aria-live="polite" role="status">{copied}</div>
      {copied && <p className="sh-muted" aria-hidden="true">{copied}</p>}
      <ol className="dev-steps">
        <li>Open PrintoutBuddy on your phone or PC.</li>
        <li>Choose Add shop and enter this code.</li>
      </ol>
      <p className="sh-muted">The code works once and expires soon. Anyone with the code can connect a device to your shop, so enter it only on your own device.</p>
      <div className="sh-actions">
        <button ref={doneBtn} className="sh-btn" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
