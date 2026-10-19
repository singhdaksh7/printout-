import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runPowerShell } from './powershell.js';

/**
 * Device credential storage. On Windows the credential is encrypted with DPAPI (CurrentUser scope + app entropy): only the
 * same Windows user on the same machine can decrypt it, and a copy of the file is useless elsewhere. No plaintext credential
 * is ever written to disk, to the environment or to the command line.
 */
export interface SecretStore {
  read(): Promise<string | null>;
  write(secret: string): Promise<void>;
  clear(): Promise<void>;
}

const ENTROPY = 'printout-buddy-windows-agent:v1';

const PROTECT = `
$in = [Console]::In.ReadToEnd().Trim()
Add-Type -AssemblyName System.Security
$e = [System.Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$b = [System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($in), $e, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($b))
`;
const UNPROTECT = PROTECT.replace('::Protect(', '::Unprotect(');

export async function dpapiProtect(plain: string): Promise<string> {
  const r = await runPowerShell(PROTECT, Buffer.from(plain, 'utf8').toString('base64'));
  if (r.code !== 0 || !r.stdout) throw new Error('DPAPI protect failed');
  return r.stdout.trim();
}

export async function dpapiUnprotect(blobB64: string): Promise<string> {
  const r = await runPowerShell(UNPROTECT, blobB64);
  if (r.code !== 0 || !r.stdout) throw new Error('DPAPI unprotect failed (a different Windows user or machine?)');
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
}

/** Restricts a directory to the current user only (removes inherited ACEs). chmod 700 off Windows. */
export function restrictToCurrentUser(dir: string): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* ignore */
    }
    return Promise.resolve();
  }
  const user = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  if (!user) return Promise.reject(new Error('Cannot determine the current Windows user'));
  const account = domain ? `${domain}\\${user}` : user;
  const icacls = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\icacls.exe`;
  return new Promise((resolve, reject) => {
    execFile(icacls, [dir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`], { windowsHide: true, timeout: 15_000 }, (err) =>
      err ? reject(new Error('Could not restrict directory permissions')) : resolve()
    );
  });
}

export class DpapiFileStore implements SecretStore {
  constructor(private readonly file: string) {}
  async read(): Promise<string | null> {
    if (!existsSync(this.file)) return null;
    return dpapiUnprotect(readFileSync(this.file, 'utf8'));
  }
  async write(secret: string): Promise<void> {
    const blob = await dpapiProtect(secret);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, blob, { mode: 0o600 });
    renameSync(tmp, this.file); // atomic: a crash leaves the old or the new credential, never half of one
  }
  async clear(): Promise<void> {
    rmSync(this.file, { force: true });
  }
}

/** Tests and non-Windows development only. */
export class MemorySecretStore implements SecretStore {
  constructor(private value: string | null = null) {}
  async read() {
    return this.value;
  }
  async write(secret: string) {
    this.value = secret;
  }
  async clear() {
    this.value = null;
  }
}
