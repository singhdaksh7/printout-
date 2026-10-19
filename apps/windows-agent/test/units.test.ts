import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, assertSafeDownloadUrl, HttpApi, normalizeApiBase } from '../src/api-client.js';
import { fileConfigSchema, loadFileConfig } from '../src/config.js';
import { Journal } from '../src/journal.js';
import { redact } from '../src/logger.js';
import { deviceJobSchema, claimResponse } from '../src/protocol.js';
import { acquireLock } from '../src/runtime.js';
import { pageRangeSetting, sumatraSettings } from '../src/spooler.js';
import { sniffMime, validateDocument, ValidationError } from '../src/validate.js';
import { ENCRYPTED_PDF, JPEG, PDF, PNG } from './harness.js';

describe('validation', () => {
  const ends = (b: Buffer) => ({ head: b.subarray(0, 2048), tail: b.subarray(Math.max(0, b.length - 2048)) });
  const v = (b: Buffer, mime: string, over: Partial<{ maxBytes: number; supported: Array<'application/pdf' | 'image/jpeg' | 'image/png'> }> = {}) =>
    validateDocument({ declaredMime: mime, size: b.length, maxBytes: over.maxBytes ?? 1_000_000, ...ends(b), supported: over.supported ?? ['application/pdf', 'image/jpeg', 'image/png'] });

  it('accepts the three supported formats when content and declared type agree', () => {
    expect(v(PDF, 'application/pdf')).toBe('application/pdf');
    expect(v(PNG, 'image/png')).toBe('image/png');
    expect(v(JPEG, 'image/jpeg')).toBe('image/jpeg');
  });
  it.each([
    ['text/plain', 'UNSUPPORTED_TYPE'],
    ['application/x-msdownload', 'UNSUPPORTED_TYPE'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'UNSUPPORTED_TYPE'],
    ['image/gif', 'UNSUPPORTED_TYPE'],
    ['image/svg+xml', 'UNSUPPORTED_TYPE']
  ])('refuses %s', (mime, code) => {
    expect(() => v(PDF, mime)).toThrowError(expect.objectContaining({ code }));
  });
  it('refuses empty, oversize, mismatched, encrypted, truncated and unsupported-on-this-machine documents', () => {
    expect(() => v(Buffer.alloc(0), 'application/pdf')).toThrowError(expect.objectContaining({ code: 'EMPTY' }));
    expect(() => v(PDF, 'application/pdf', { maxBytes: 10 })).toThrowError(expect.objectContaining({ code: 'TOO_LARGE' }));
    expect(() => v(PNG, 'application/pdf')).toThrowError(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    expect(() => v(ENCRYPTED_PDF, 'application/pdf')).toThrowError(expect.objectContaining({ code: 'ENCRYPTED_PDF' }));
    expect(() => v(Buffer.from('%PDF-1.7 no end'), 'application/pdf')).toThrowError(expect.objectContaining({ code: 'MALFORMED' }));
    expect(() => v(PDF, 'application/pdf', { supported: ['image/png'] })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_TYPE' }));
    expect(() => v(Buffer.from('MZ....'), 'application/pdf')).toThrow(ValidationError);
  });
  it('sniffs by content only', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffMime(Buffer.from('<svg'))).toBeNull();
  });
});

describe('server address and download URL rules (TLS)', () => {
  it('requires https, no credentials, no query; appends /api/v1', () => {
    expect(normalizeApiBase('https://app.example.com')).toBe('https://app.example.com/api/v1');
    expect(normalizeApiBase('https://app.example.com/api/v1/')).toBe('https://app.example.com/api/v1');
    expect(() => normalizeApiBase('http://app.example.com')).toThrow(/https/);
    expect(() => normalizeApiBase('https://u:p@app.example.com')).toThrow(/credentials/);
    expect(() => normalizeApiBase('https://app.example.com/?x=1')).toThrow(/query/);
    expect(() => normalizeApiBase('ftp://app.example.com')).toThrow();
    expect(() => normalizeApiBase('not a url')).toThrow();
  });
  it('plain http only for loopback and only when explicitly allowed', () => {
    expect(() => normalizeApiBase('http://127.0.0.1:3000')).toThrow();
    expect(normalizeApiBase('http://127.0.0.1:3000', true)).toBe('http://127.0.0.1:3000/api/v1');
    expect(() => normalizeApiBase('http://192.168.1.10:3000', true)).toThrow();
  });
  it('download URLs: https only, relative URLs resolve against the API origin, no embedded credentials', () => {
    expect(assertSafeDownloadUrl('https://files.example.com/x?sig=1', 'https://app.example.com/api/v1', false).host).toBe('files.example.com');
    expect(assertSafeDownloadUrl('/api/v1/internal/documents/k?sig=1', 'https://app.example.com/api/v1', false).origin).toBe('https://app.example.com');
    expect(() => assertSafeDownloadUrl('http://files.example.com/x', 'https://app.example.com/api/v1', false)).toThrow();
    expect(() => assertSafeDownloadUrl('https://u:p@files.example.com/x', 'https://app.example.com/api/v1', false)).toThrow();
    expect(() => assertSafeDownloadUrl('file:///C:/Windows/win.ini', 'https://app.example.com/api/v1', false)).toThrow();
  });
});

describe('http client', () => {
  const mk = (responses: Array<() => Response | Promise<Response>>) => {
    let i = 0;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return r();
    }) as unknown as typeof fetch;
    const api = new HttpApi({ baseUrl: 'https://x.test/api/v1', userAgent: 't', fetchImpl, sleep: async () => undefined });
    api.setCredential('pbd_secretsecretsecretsecretsecretsecret1234');
    return { api, calls };
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('sends the bearer credential, refuses redirects, never in the URL', async () => {
    const { api, calls } = mk([json(200, { data: { heartbeatIntervalSeconds: 60 } })]);
    await api.heartbeat({ appVersion: '1', osVersion: 'w' });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(/^Bearer pbd_/);
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.url).not.toContain('pbd_');
  });
  it('retries 5xx / 429 / network but not 4xx; surfaces fatal auth', async () => {
    const ok = json(200, { data: { heartbeatIntervalSeconds: 60 } });
    const a = mk([json(503, { error: { code: 'X', message: 'm' } }), json(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '1' }), ok]);
    await a.api.heartbeat({ appVersion: '1', osVersion: 'w' });
    expect(a.calls).toHaveLength(3);
    const b = mk([json(409, { error: { code: 'LEASE_MISMATCH', message: 'm' } })]);
    await expect(b.api.claim()).rejects.toMatchObject({ status: 409, code: 'LEASE_MISMATCH', retryable: false });
    expect(b.calls).toHaveLength(1);
    const c = mk([json(401, { error: { code: 'DEVICE_REVOKED', message: 'gone' } })]);
    const err = await c.api.claim().catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).fatalAuth).toBe(true);
  });
  it('treats a response that does not match the contract as an error, never as an instruction', async () => {
    const { api } = mk([json(200, { data: { job: { id: '../../etc/passwd', status: 'QUEUED' }, resumed: false } })]);
    await expect(api.claim()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('contract: a real-shaped claim parses; a hostile document name or job id is rejected', () => {
    const good = {
      id: 'cmvbu1hdu00orvetsba2g8hsa', orderId: 'o1', status: 'CLAIMED', attempt: 1, leaseId: '7d6e0f4c-8f3a-4f1b-9d3a-0f1e2d3c4b5a', leaseExpiresAt: null,
      cancelRequested: false, statusBeforeCancel: null, printer: { id: 'p', name: 'HP' },
      options: { copies: 1, colourMode: 'bw', sides: 'single', paperSize: 'A4', pageSelection: { mode: 'all' } }, spoolerJobId: null, documentName: 'pb-cmvbu1hdu00orvetsba2g8hsa-1'
    };
    expect(claimResponse.safeParse({ data: { job: good, resumed: false } }).success).toBe(true);
    expect(deviceJobSchema.safeParse({ ...good, documentName: 'pb-x/../../y-1' }).success).toBe(false);
    expect(deviceJobSchema.safeParse({ ...good, id: '..\\..\\evil' }).success).toBe(false);
    expect(deviceJobSchema.safeParse({ ...good, options: { ...good.options, copies: 0 } }).success).toBe(false);
  });
});

describe('printing settings (no shell, validated numbers only)', () => {
  const o = (over: object) => ({ copies: 1, colourMode: 'bw', sides: 'single', paperSize: 'A4', pageSelection: { mode: 'all' }, ...over }) as never;
  it('builds renderer settings from enums and integers', () => {
    expect(sumatraSettings(o({}))).toBe('monochrome,simplex,paper=A4');
    expect(sumatraSettings(o({ copies: 3, colourMode: 'colour', sides: 'duplex', pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 2 }, { from: 4, to: 4 }] } }))).toBe('1-2,4,color,duplexlong,3x,paper=A4');
    expect(pageRangeSetting({ mode: 'all' })).toBeNull();
  });
});

describe('logging', () => {
  it('redacts credentials, bearer tokens, signed URL queries and pairing codes', () => {
    const line = redact('auth Bearer pbd_abcdefghijklmnopqrstuvwxyz0123456789 url https://files.test/doc?exp=1&sig=SECRET code PB-AB12-CD34 key pbd_abcdefghijklmnopqrstuv');
    expect(line).not.toMatch(/abcdefghijklmnop|SECRET|AB12-CD34/);
    expect(line).toContain('https://files.test/doc?[redacted]');
  });
});

describe('journal', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-journal-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('folds events, tolerates a torn last line, compacts finished jobs away and never stores document data', () => {
    const j = new Journal(join(dir, 'j.jsonl'));
    j.append({ ev: 'claimed', jobId: 'job00000001', attempt: 1, leaseId: 'l1', printerName: 'P' });
    j.append({ ev: 'submit-begin', jobId: 'job00000001', attempt: 1, leaseId: 'l1', printerName: 'P', documentName: 'pb-job00000001-1', queuedIds: [3] });
    j.append({ ev: 'report', jobId: 'job00000001', leaseId: 'l1', status: 'PRINT_INITIATED' });
    appendFileSync(join(dir, 'j.jsonl'), '{"ev":"acked","jobId":"job0'); // torn write
    const m = j.state().get('job00000001')!;
    expect(m).toMatchObject({ submitBegun: true, queuedIds: [3], done: false, unacked: { status: 'PRINT_INITIATED' } });
    j.append({ ev: 'acked', jobId: 'job00000001', status: 'PRINT_INITIATED' });
    j.append({ ev: 'done', jobId: 'job00000001' });
    j.compact();
    expect(j.state().size).toBe(0);
    expect(readFileSync(join(dir, 'j.jsonl'), 'utf8')).toBe('');
  });
});

describe('settings file', () => {
  it('rejects unknown keys and out-of-range values; defaults are safe', () => {
    expect(fileConfigSchema.parse({})).toMatchObject({ maxDocumentMB: 50, monitorSeconds: 120 });
    expect(fileConfigSchema.safeParse({ maxDocumentMb: 500 }).success).toBe(false);
    expect(fileConfigSchema.safeParse({ maxDocumentMB: 5000 }).success).toBe(false);
    expect(fileConfigSchema.safeParse({ pdfRenderer: { path: 'C:\\x\\S.exe', sha256: 'zz' } }).success).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'pb-cfg-'));
    writeFileSync(join(dir, 'c.json'), '{ not json');
    expect(() => loadFileConfig(join(dir, 'c.json'))).toThrow(/not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('single instance lock', () => {
  it('refuses a second live agent, replaces a stale lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-lock-'));
    const lock = join(dir, 'agent.lock');
    const release = acquireLock(lock);
    expect(() => acquireLock(lock)).toThrow(/already running/);
    release();
    writeFileSync(lock, '999999999'); // a pid that does not exist
    const again = acquireLock(lock);
    again();
    rmSync(dir, { recursive: true, force: true });
  });
});
