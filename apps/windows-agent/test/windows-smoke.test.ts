import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPowerShell } from '../src/powershell.js';
import { DpapiFileStore, dpapiProtect, dpapiUnprotect, restrictToCurrentUser } from '../src/secure-store.js';
import { WindowsSpooler } from '../src/spooler.js';
import { autostartState } from '../src/tasks.js';

/**
 * Real-Windows smoke tests (skipped elsewhere). They are READ-ONLY: they never print, never create printers and never touch
 * the print queue. They prove that the PowerShell/DPAPI plumbing works on a real Windows host.
 * They do NOT prove physical printing: see docs/WINDOWS_AGENT.md ("REAL HARDWARE PRINTING UNVERIFIED").
 */
const win = process.platform === 'win32';

describe.skipIf(!win)('Windows host', () => {
  it('PowerShell receives data on stdin as UTF-8 and returns it', async () => {
    const r = await runPowerShell("$d = [Console]::In.ReadToEnd() | ConvertFrom-Json; [Console]::Out.Write($d.text)", JSON.stringify({ text: 'Zażółć 打印机 ✓' }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Zażółć 打印机 ✓');
  });

  it('DPAPI round trip; the protected blob does not contain the secret; the file store never writes plaintext', async () => {
    const secret = 'pbd_unit-test-secret-0123456789';
    const blob = await dpapiProtect(secret);
    expect(Buffer.from(blob, 'base64').toString('latin1')).not.toContain('unit-test-secret');
    expect(await dpapiUnprotect(blob)).toBe(secret);
    const dir = mkdtempSync(join(tmpdir(), 'pb-dpapi-'));
    try {
      const store = new DpapiFileStore(join(dir, 'cred.dpapi'));
      await store.write(secret);
      expect(readFileSync(join(dir, 'cred.dpapi'), 'utf8')).not.toContain('unit-test-secret');
      expect(await store.read()).toBe(secret);
      await store.clear();
      expect(await store.read()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tampered DPAPI blob is rejected', async () => {
    const blob = await dpapiProtect('x');
    const bad = Buffer.from(blob, 'base64');
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    await expect(dpapiUnprotect(bad.toString('base64'))).rejects.toThrow();
  });

  it('directory permissions can be restricted to the current user (no inherited broad groups)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-acl-'));
    try {
      await restrictToCurrentUser(dir);
      const icacls = String.raw`${process.env.SystemRoot ?? 'C:\\Windows'}\System32\icacls.exe`;
      const out = execFileSync(icacls, [dir], { encoding: 'utf8', windowsHide: true });
      const user = (process.env.USERNAME ?? '').toLowerCase();
      const lower = out.toLowerCase();
      expect(lower, out).toContain(`\\${user}:`);
      for (const broad of ['everyone', String.raw`builtin\users`, 'authenticated users']) {
        expect(lower, `${broad} must not have access:\n${out}`).not.toContain(`${broad}:`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('real printer discovery returns well-formed printers (read only)', async () => {
    const printers = await new WindowsSpooler().listPrinters();
    expect(Array.isArray(printers)).toBe(true);
    for (const p of printers) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(['ONLINE', 'OFFLINE', 'ERROR', 'UNKNOWN']).toContain(p.connectivity);
      expect(typeof p.supportsColour).toBe('boolean');
      expect(typeof p.supportsDuplex).toBe('boolean');
      expect(Array.isArray(p.paperSizes)).toBe(true);
    }
  });

  it('PDF printing is reported unsupported without a renderer, and an unreadable queue/printer fails cleanly', async () => {
    const s = new WindowsSpooler({});
    expect(await s.supportedMimeTypes()).toEqual(['image/jpeg', 'image/png']);
    await expect(s.submit({ printerName: 'x', filePath: 'C:\\nope.pdf', mime: 'application/pdf', documentName: 'pb-x-1', options: { copies: 1, colourMode: 'bw', sides: 'single', paperSize: 'A4', pageSelection: { mode: 'all' } } })).rejects.toMatchObject({ kind: 'NOT_STARTED', code: 'RENDERER_MISSING' });
    const pinned = new WindowsSpooler({ pdfRendererPath: process.env.SystemRoot + '\\System32\\notepad.exe', pdfRendererSha256: '0'.repeat(64) });
    expect(await pinned.supportedMimeTypes()).toEqual(['image/jpeg', 'image/png']); // checksum mismatch => renderer refused
  });

  it('a printer name that is not installed is rejected by the image pipeline BEFORE anything is spooled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-img-'));
    try {
      const { writeFileSync } = await import('node:fs');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const file = join(dir, 'pb-x-1.png');
      writeFileSync(file, png);
      await expect(
        new WindowsSpooler({}).submit({ printerName: 'Printer-That-Does-Not-Exist-7f3a', filePath: file, mime: 'image/png', documentName: 'pb-x-1', options: { copies: 1, colourMode: 'bw', sides: 'single', paperSize: 'A4', pageSelection: { mode: 'all' } } })
      ).rejects.toMatchObject({ kind: 'NOT_STARTED', code: 'PRINTER_NOT_FOUND' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('autostart state can be queried (read only)', async () => {
    expect(typeof (await autostartState())).toBe('string');
  });
});
