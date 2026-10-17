import { execFile } from 'node:child_process';

/**
 * The ONLY way the agent talks to Windows PowerShell. Rules:
 *  - scripts are static strings in this package; data reaches them through stdin, never by string interpolation;
 *  - executed with execFile (no shell), -NoProfile, -NonInteractive;
 *  - bounded by a timeout and an output cap.
 */
export interface PsResult {
  stdout: string;
  stderr: string;
  code: number;
}

export const POWERSHELL_PATH = () => `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

const PREAMBLE =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::InputEncoding=[System.Text.Encoding]::UTF8;";

export function runPowerShell(script: string, stdin: string | undefined, timeoutMs = 30_000): Promise<PsResult> {
  const encoded = Buffer.from(PREAMBLE + script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile(
      POWERSHELL_PATH(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(error);
        const killed = (error as { killed?: boolean } | null)?.killed === true;
        const raw = (error as { code?: unknown } | null)?.code;
        resolve({ stdout: String(stdout), stderr: String(stderr), code: killed ? 124 : error ? (typeof raw === 'number' ? raw : 1) : 0 });
      }
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin ?? '');
  });
}
