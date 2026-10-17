import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { runPowerShell } from './powershell.js';
import type { JobOptions, PrinterReport, SupportedMime } from './protocol.js';

/**
 * Windows spooler boundary. Everything the engine knows about printing goes through this interface so that the whole job
 * lifecycle can be tested with FakeSpooler (src/testing/fake-spooler.ts) without a printer.
 *
 * HONESTY RULE: nothing here can observe paper. `findJobs` reports the spooler QUEUE. The engine therefore never reports a
 * job as printed; the best it can say is PRINT_INITIATED.
 */
export interface SpoolerJob {
  id: number;
  documentName: string;
  /** Raw Windows JobStatus flags, e.g. ["Printing"], ["Error","Offline"], ["Printed"]. */
  flags: string[];
  totalPages: number | null;
  pagesPrinted: number | null;
}

export interface SubmitRequest {
  printerName: string;
  /** Absolute path of the validated temporary file. */
  filePath: string;
  mime: SupportedMime;
  /** pb-<jobId>-<attempt>: also the file's base name so the spooler document name carries it. */
  documentName: string;
  options: JobOptions;
}

/** NOT_STARTED: provably nothing reached the spooler (safe to retry). AFTER_START: the renderer ran; the spooler may hold pages. */
export class SubmitError extends Error {
  constructor(
    public readonly kind: 'NOT_STARTED' | 'AFTER_START',
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SubmitError';
  }
}

export interface Spooler {
  listPrinters(): Promise<PrinterReport[]>;
  /** Which document types this installation can print right now (a missing PDF renderer removes application/pdf). */
  supportedMimeTypes(): Promise<SupportedMime[]>;
  /** Ids currently queued on the printer (taken just before submitting, to identify the new job afterwards). */
  listJobs(printerName: string): Promise<SpoolerJob[]>;
  /** Resolves when the renderer returned success. Throws SubmitError. */
  submit(req: SubmitRequest): Promise<void>;
  /** Removes a queued job. Resolves true only when the job is confirmed gone afterwards. */
  removeJob(printerName: string, jobId: number): Promise<boolean>;
}

export const MAX_PRINTER_NAME = 200;

/* ------------------------------ PowerShell scripts (static) ------------------------------ */

const LIST_PRINTERS = `
Add-Type -AssemblyName System.Drawing
$result = @()
foreach ($p in @(Get-Printer)) {
  $status = [string]$p.PrinterStatus
  $detail = $status
  $conn = 'ONLINE'
  if ($p.WorkOffline -eq $true) { $conn = 'OFFLINE'; $detail = 'Offline (work offline)' }
  elseif ($status -in @('Offline','NotAvailable','ServerUnknown')) { $conn = 'OFFLINE' }
  elseif ($status -in @('Error','PaperJam','PaperOut','PaperProblem','NoToner','DoorOpen','OutOfMemory','UserIntervention','OutputBinFull','Paused','PagePunt')) { $conn = 'ERROR' }
  $colour = $false; $duplex = $false; $papers = @()
  try {
    $ps = New-Object System.Drawing.Printing.PrinterSettings
    $ps.PrinterName = $p.Name
    if ($ps.IsValid) {
      $colour = [bool]$ps.SupportsColor
      $duplex = [bool]$ps.CanDuplex
      foreach ($s in $ps.PaperSizes) { if ($papers.Count -lt 60) { $papers += [string]$s.PaperName } }
    }
  } catch { }
  $result += [pscustomobject]@{ name = [string]$p.Name; driverName = [string]$p.DriverName; connectivity = $conn; statusDetail = $detail; supportsColour = $colour; supportsDuplex = $duplex; paperSizes = @($papers) }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($result) -Compress -Depth 4))
`;

const LIST_JOBS = `
$cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
$jobs = @(Get-PrintJob -PrinterName $cfg.printer | ForEach-Object {
  [pscustomobject]@{ id = [int]$_.Id; documentName = [string]$_.DocumentName; flags = @(([string]$_.JobStatus).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }); totalPages = [int]$_.TotalPages; pagesPrinted = [int]$_.PagesPrinted }
})
[Console]::Out.Write((ConvertTo-Json -InputObject @($jobs) -Compress -Depth 4))
`;

const REMOVE_JOB = `
$cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
try { Remove-PrintJob -PrinterName $cfg.printer -ID ([int]$cfg.id) } catch { }
$left = @(Get-PrintJob -PrinterName $cfg.printer | Where-Object { $_.Id -eq [int]$cfg.id })
[Console]::Out.Write($(if ($left.Count -eq 0) { 'GONE' } else { 'PRESENT' }))
`;

/** Prints one JPEG/PNG with the built-in .NET printing stack. Exit 12: unknown printer, 13: unreadable image. */
const PRINT_IMAGE = `
Add-Type -AssemblyName System.Drawing
$cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $cfg.printer
if (-not $doc.PrinterSettings.IsValid) { exit 12 }
try { $img = [System.Drawing.Image]::FromFile($cfg.file) } catch { exit 13 }
$doc.DocumentName = [string]$cfg.documentName
$doc.PrinterSettings.Copies = [int16]$cfg.copies
$doc.DefaultPageSettings.Color = [bool]$cfg.colour
$doc.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex
$doc.DefaultPageSettings.Landscape = ($img.Width -gt $img.Height)
$doc.add_PrintPage({
  param($sender, $e)
  $b = $e.MarginBounds
  $scale = [Math]::Min($b.Width / $img.Width, $b.Height / $img.Height)
  $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)
  $e.Graphics.DrawImage($img, [int]($b.Left + ($b.Width - $w) / 2), [int]($b.Top + ($b.Height - $h) / 2), $w, $h)
  $e.HasMorePages = $false
})
try { $doc.Print() } finally { $img.Dispose(); $doc.Dispose() }
`;

/* ------------------------------ helpers ------------------------------ */

export function pageRangeSetting(sel: JobOptions['pageSelection']): string | null {
  if (sel.mode === 'all') return null;
  return sel.ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(',');
}

/** SumatraPDF -print-settings value. Only values built from validated numbers/enums are interpolated. */
export function sumatraSettings(o: JobOptions): string {
  const parts: string[] = [];
  const pages = pageRangeSetting(o.pageSelection);
  if (pages) parts.push(pages);
  parts.push(o.colourMode === 'colour' ? 'color' : 'monochrome');
  parts.push(o.sides === 'duplex' ? 'duplexlong' : 'simplex');
  if (o.copies > 1) parts.push(`${o.copies}x`);
  if (o.paperSize === 'A4') parts.push('paper=A4');
  return parts.join(',');
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Unexpected ${what} output`);
  }
}

export interface WindowsSpoolerOptions {
  /** Absolute path of SumatraPDF.exe (optional; without it PDF jobs fail safely before the spooler). */
  pdfRendererPath?: string | undefined;
  /** If set, the renderer binary must hash to this value, otherwise it is refused (tamper protection). */
  pdfRendererSha256?: string | undefined;
  renderTimeoutMs?: number;
}

export class WindowsSpooler implements Spooler {
  constructor(private readonly opts: WindowsSpoolerOptions = {}) {}

  async listPrinters(): Promise<PrinterReport[]> {
    const r = await runPowerShell(LIST_PRINTERS, undefined, 60_000);
    if (r.code !== 0) throw new Error('Could not list printers');
    const raw = parseJson<Array<Record<string, unknown>>>(r.stdout || '[]', 'printer list');
    return raw
      .filter((p) => typeof p.name === 'string' && p.name.length > 0 && p.name.length <= MAX_PRINTER_NAME)
      .map((p) => ({
        name: String(p.name),
        driverName: typeof p.driverName === 'string' && p.driverName ? p.driverName.slice(0, 200) : undefined,
        connectivity: (['ONLINE', 'OFFLINE', 'ERROR', 'UNKNOWN'].includes(String(p.connectivity)) ? p.connectivity : 'UNKNOWN') as PrinterReport['connectivity'],
        statusDetail: typeof p.statusDetail === 'string' && p.statusDetail ? p.statusDetail.slice(0, 200) : undefined,
        supportsColour: p.supportsColour === true,
        supportsDuplex: p.supportsDuplex === true,
        paperSizes: Array.isArray(p.paperSizes) ? p.paperSizes.filter((x): x is string => typeof x === 'string').slice(0, 60) : []
      })) as PrinterReport[];
  }

  private pdfRendererOk(): { ok: true; path: string } | { ok: false; reason: string } {
    const path = this.opts.pdfRendererPath;
    if (!path) return { ok: false, reason: 'No PDF renderer is configured' };
    try {
      accessSync(path, constants.R_OK);
      if (this.opts.pdfRendererSha256 && sha256File(path) !== this.opts.pdfRendererSha256.toLowerCase()) {
        return { ok: false, reason: 'The PDF renderer does not match the pinned checksum' };
      }
    } catch {
      return { ok: false, reason: 'The PDF renderer cannot be read' };
    }
    return { ok: true, path };
  }

  async supportedMimeTypes(): Promise<SupportedMime[]> {
    return this.pdfRendererOk().ok ? ['application/pdf', 'image/jpeg', 'image/png'] : ['image/jpeg', 'image/png'];
  }

  async listJobs(printerName: string): Promise<SpoolerJob[]> {
    const r = await runPowerShell(LIST_JOBS, JSON.stringify({ printer: printerName }), 30_000);
    if (r.code !== 0) throw new Error('Could not read the print queue');
    const raw = parseJson<Array<Record<string, unknown>>>(r.stdout || '[]', 'queue');
    return raw.map((j) => ({
      id: Number(j.id),
      documentName: String(j.documentName ?? ''),
      flags: Array.isArray(j.flags) ? j.flags.map(String) : [],
      totalPages: typeof j.totalPages === 'number' ? j.totalPages : null,
      pagesPrinted: typeof j.pagesPrinted === 'number' ? j.pagesPrinted : null
    }));
  }

  async removeJob(printerName: string, jobId: number): Promise<boolean> {
    const r = await runPowerShell(REMOVE_JOB, JSON.stringify({ printer: printerName, id: jobId }), 30_000);
    return r.code === 0 && r.stdout.trim() === 'GONE';
  }

  async submit(req: SubmitRequest): Promise<void> {
    const timeout = this.opts.renderTimeoutMs ?? 120_000;
    if (req.mime === 'application/pdf') {
      const renderer = this.pdfRendererOk();
      if (!renderer.ok) throw new SubmitError('NOT_STARTED', 'RENDERER_MISSING', renderer.reason);
      // execFile + argv array: the file path, printer name and settings are single arguments, never parsed by a shell.
      await new Promise<void>((resolve, reject) => {
        execFile(
          renderer.path,
          ['-print-to', req.printerName, '-print-settings', sumatraSettings(req.options), '-silent', '-exit-when-done', req.filePath],
          { windowsHide: true, timeout, shell: false },
          (error) => {
            if (!error) return resolve();
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new SubmitError('NOT_STARTED', 'RENDERER_MISSING', 'The PDF renderer could not be started'));
            reject(new SubmitError('AFTER_START', 'RENDERER_EXIT', 'The PDF renderer did not finish cleanly'));
          }
        );
      });
      return;
    }
    const r = await runPowerShell(
      PRINT_IMAGE,
      JSON.stringify({ printer: req.printerName, file: req.filePath, documentName: req.documentName, copies: req.options.copies, colour: req.options.colourMode === 'colour' }),
      timeout
    ).catch(() => {
      throw new SubmitError('NOT_STARTED', 'POWERSHELL_UNAVAILABLE', 'Windows PowerShell could not be started');
    });
    if (r.code === 12) throw new SubmitError('NOT_STARTED', 'PRINTER_NOT_FOUND', 'The printer is not installed on this computer');
    if (r.code === 13) throw new SubmitError('NOT_STARTED', 'IMAGE_UNREADABLE', 'The image could not be read');
    if (r.code !== 0) throw new SubmitError('AFTER_START', 'RENDERER_EXIT', 'Image printing did not finish cleanly');
  }
}
