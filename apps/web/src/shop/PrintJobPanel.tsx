import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  cancelPrintJob, describeError, enqueuePrintJob, listDevices, listPrintJobs, reconcilePrintJob, retryPrintJob,
  type PrinterView, type PrintJobStatus, type PrintJobView, type Reconciliation
} from '../lib/shop-api';
import { Banner, Button, Chip, type ChipTone } from '../ui';
import { useAutoRefresh } from './hooks';
import { useRealtimeRefresh } from './realtime';

/**
 * Honest wording: nothing here ever says "printed". PRINT_INITIATED = the Windows print queue accepted the job; only the shopkeeper,
 * holding the paper, can say it printed (the existing "mark printed" flow stays manual).
 */
export const JOB_LABEL: Record<PrintJobStatus, string> = {
  QUEUED: 'Waiting for the Windows computer',
  CLAIMED: 'Preparing',
  DOWNLOADING: 'Preparing',
  SUBMITTING: 'Sending to the print queue',
  SUBMITTED_TO_SPOOLER: 'In the Windows print queue',
  PRINT_INITIATED: 'Print initiated',
  FAILED: 'Failed',
  CANCEL_REQUESTED: 'Cancel requested',
  CANCELED: 'Canceled',
  NEEDS_RECONCILIATION: 'Needs your check'
};
const TONE: Record<PrintJobStatus, ChipTone> = {
  QUEUED: 'neutral', CLAIMED: 'info', DOWNLOADING: 'info', SUBMITTING: 'info', SUBMITTED_TO_SPOOLER: 'info', PRINT_INITIATED: 'ok',
  FAILED: 'err', CANCEL_REQUESTED: 'warn', CANCELED: 'neutral', NEEDS_RECONCILIATION: 'warn'
};
const ACTIVE: ReadonlySet<PrintJobStatus> = new Set(['QUEUED', 'CLAIMED', 'DOWNLOADING', 'SUBMITTING', 'SUBMITTED_TO_SPOOLER', 'CANCEL_REQUESTED', 'NEEDS_RECONCILIATION']);
const CANCELABLE: ReadonlySet<PrintJobStatus> = new Set(['QUEUED', 'CLAIMED', 'DOWNLOADING', 'SUBMITTING', 'SUBMITTED_TO_SPOOLER', 'PRINT_INITIATED']);

export function PrintJobChip({ job }: { job: Pick<PrintJobView, 'status'> }) {
  return <Chip tone={TONE[job.status]} size="sm" data-testid="print-job-chip">{JOB_LABEL[job.status]}</Chip>;
}

/** Latest job per order, from the list the queue already fetched. */
export function latestByOrder(jobs: PrintJobView[]): Map<string, PrintJobView> {
  const m = new Map<string, PrintJobView>();
  for (const j of jobs) {
    const cur = m.get(j.orderId);
    if (!cur || Date.parse(j.createdAt) > Date.parse(cur.createdAt)) m.set(j.orderId, j);
  }
  return m;
}

const ERROR_HELP: Record<string, string> = {
  RENDERER_MISSING: 'No PDF printing component is installed on the Windows computer. Nothing was sent.',
  PRINTER_OFFLINE: 'The printer was not ready. Nothing was sent.',
  PRINTER_NOT_FOUND: 'The printer is not installed on the Windows computer. Nothing was sent.',
  UNSUPPORTED_TYPE: 'This kind of file cannot be printed by the Windows agent.',
  ENCRYPTED_PDF: 'The PDF is password protected.',
  TOO_LARGE: 'The file is too large for the Windows agent.',
  DOWNLOAD_FAILED: 'The Windows computer could not download the file. Nothing was sent.',
  SPOOLER_ERROR: 'The Windows print queue reports a printer problem. The job may still print once it is fixed.',
  SPOOLER_STALLED: 'The job is stuck in the Windows print queue. It may still print.',
  LEASE_EXPIRED_AFTER_SUBMIT: 'The Windows computer stopped responding after the job was sent. It may or may not have printed.',
  OUTCOME_UNKNOWN: 'The Windows computer lost track of this job. It may or may not have printed.'
};

export function PrintJobPanel({ orderId, canPrint, onChanged }: { orderId: string; canPrint: boolean; onChanged?: () => void }) {
  const [jobs, setJobs] = useState<PrintJobView[] | null>(null);
  const [printer, setPrinter] = useState<PrinterView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(() => {
    listPrintJobs(orderId).then((r) => { if (mounted.current) setJobs(r.jobs); }).catch(() => { if (mounted.current) setJobs((j) => j ?? []); });
    listDevices().then((r) => {
      if (!mounted.current) return;
      const p = r.devices.filter((d) => d.platform === 'WINDOWS' && d.status === 'ACTIVE').flatMap((d) => d.printers ?? []).find((x) => x.isDefault && x.authorized && x.present);
      setPrinter(p ?? null);
    }).catch(() => { if (mounted.current) setPrinter((p) => (p === undefined ? null : p)); });
  }, [orderId]);
  useEffect(load, [load]);
  const hasActive = !!jobs?.some((j) => ACTIVE.has(j.status));
  useAutoRefresh(load, hasActive ? 5_000 : 30_000);
  useRealtimeRefresh(() => load());

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key); setError(null);
    try { await fn(); load(); onChanged?.(); } catch (e) { setError(describeError(e)); load(); } finally { if (mounted.current) setBusy(null); }
  };

  const latest = jobs?.[0];
  const blocking = !!latest && ACTIVE.has(latest.status);
  const risky = !!latest && latest.status === 'FAILED' && latest.duplicateRisk;
  const startLabel = latest?.status === 'PRINT_INITIATED' ? 'Print again' : 'Print on Windows printer';

  if (jobs === null || printer === undefined) return null;
  if (!printer && jobs.length === 0) return null; // no Windows setup and no history: stay out of the way

  return (
    <section aria-label="Windows printer" className="pb-pj" data-testid="print-job-panel">
      <h2 className="pb-h3">Windows printer</h2>
      {error && <Banner tone="err" onDismiss={() => setError(null)}>{error}</Banner>}
      {canPrint && printer && !blocking && (
        <div className="pb-od-actions__row">
          <Button
            variant="primary" loading={busy === 'start'} disabled={!!busy}
            onClick={() => {
              if (risky && !window.confirm('The previous attempt may already have printed. Check the printer first. Print again anyway?')) return;
              void run('start', () => enqueuePrintJob(orderId, { printerId: printer.id, reprint: latest?.status === 'PRINT_INITIATED', ...(risky ? { acknowledgeDuplicateRisk: true } : {}) }));
            }}
          >
            {startLabel}
          </Button>
          <span className="pb-muted">{printer.name}{printer.connectivity !== 'ONLINE' ? ` (${printer.connectivity.toLowerCase()})` : ''}</span>
        </div>
      )}
      {canPrint && !printer && (
        <p className="pb-muted">No default Windows printer is set. <Link to="/shop/devices">Choose one in Devices</Link>.</p>
      )}
      <ul className="pb-pj__list" aria-label="Print jobs">
        {jobs.map((j) => (
          <li key={j.id} className="pb-pj__item" data-testid="print-job">
            <div className="pb-pj__head">
              <PrintJobChip job={j} />
              <span className="pb-muted pb-wrap">{j.printerName ?? 'Printer'}{j.attempt > 1 ? ` · attempt ${j.attempt}` : ''}</span>
            </div>
            {j.status === 'PRINT_INITIATED' && (
              <p className="pb-muted">The Windows print queue accepted this job{j.spoolerState ? ` (${j.spoolerState})` : ''}. This does not confirm paper came out: check the printer.</p>
            )}
            {(j.errorCode || j.errorMessage) && j.status !== 'PRINT_INITIATED' && (
              <p className="pb-muted pb-wrap" data-testid="print-job-error">{(j.errorCode && ERROR_HELP[j.errorCode]) ?? j.errorMessage ?? 'Something went wrong.'}</p>
            )}
            {j.status === 'FAILED' && j.duplicateRisk && <p className="pb-muted">This job may already have reached the printer. Check before printing again.</p>}
            <div className="pb-pj__actions">
              {CANCELABLE.has(j.status) && (
                <Button size="sm" variant="outline" disabled={!!busy} loading={busy === `c${j.id}`} onClick={() => void run(`c${j.id}`, () => cancelPrintJob(j.id))}>Cancel</Button>
              )}
              {j.status === 'FAILED' && !latestIsNewer(jobs, j) && (
                <Button size="sm" variant="outline" disabled={!!busy} loading={busy === `r${j.id}`} onClick={() => {
                  if (j.duplicateRisk && !window.confirm('This job may already have printed. Print again anyway?')) return;
                  void run(`r${j.id}`, () => retryPrintJob(j.id, j.duplicateRisk));
                }}>Retry</Button>
              )}
              {j.status === 'NEEDS_RECONCILIATION' && (
                <fieldset className="pb-pj__reconcile">
                  <legend className="pb-muted">Look at the printer, then tell us what happened:</legend>
                  {([['PRINTED', 'It printed'], ['NOT_PRINTED_REQUEUE', 'It did not print: print again'], ['NOT_PRINTED_GIVE_UP', 'It did not print: stop']] as Array<[Reconciliation, string]>).map(([r, label]) => (
                    <Button key={r} size="sm" variant="outline" disabled={!!busy} onClick={() => void run(`x${j.id}${r}`, () => reconcilePrintJob(j.id, r))}>{label}</Button>
                  ))}
                </fieldset>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const latestIsNewer = (jobs: PrintJobView[], j: PrintJobView) => jobs.some((o) => o.id !== j.id && Date.parse(o.createdAt) > Date.parse(j.createdAt));
