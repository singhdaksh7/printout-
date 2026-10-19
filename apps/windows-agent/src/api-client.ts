import { z } from 'zod';
import {
  activeResponse, claimResponse, downloadResponse, errorEnvelope, heartbeatResponse, pairResponse, printersResponse,
  progressResponse, rotateResponse, type DeviceJob, type PrinterReport, type ProgressReport
} from './protocol.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** The server says this credential/device is finished: stop, do not retry. */
  get fatalAuth(): boolean {
    return this.status === 401 || this.code === 'DEVICE_REVOKED';
  }
}

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

/** TLS is mandatory. Plain http is only accepted for loopback AND only when explicitly allowed (development/tests). */
export function normalizeApiBase(input: string, allowInsecureLoopback = false): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error('The server address is not a valid URL');
  }
  if (u.username || u.password) throw new Error('The server address must not contain credentials');
  if (u.search || u.hash) throw new Error('The server address must not contain a query string');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowInsecureLoopback && isLoopback(u.hostname))) {
    throw new Error('The server address must use https://');
  }
  let path = u.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/api/v1')) path += '/api/v1';
  return `${u.origin}${path}`;
}

/** Download URLs come from the server but are still held to the TLS rule and must carry no credentials. */
export function assertSafeDownloadUrl(raw: string, apiBase: string, allowInsecureLoopback: boolean): URL {
  const u = new URL(raw, apiBase.replace(/\/api\/v1$/, '/'));
  if (u.username || u.password) throw new Error('Unsafe download address');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowInsecureLoopback && isLoopback(u.hostname))) throw new Error('Download address must use https');
  return u;
}

export interface AgentApi {
  setCredential(secret: string): void;
  heartbeat(info: { appVersion: string; osVersion: string }): Promise<{ heartbeatIntervalSeconds: number }>;
  reportPrinters(printers: PrinterReport[]): Promise<Array<{ id: string; name: string; authorized: boolean; isDefault: boolean; present: boolean }>>;
  claim(): Promise<{ job: DeviceJob | null; resumed: boolean }>;
  active(): Promise<DeviceJob[]>;
  download(jobId: string, leaseId: string): Promise<z.infer<typeof downloadResponse>['data']>;
  progress(jobId: string, report: ProgressReport): Promise<DeviceJob>;
  rotate(): Promise<z.infer<typeof rotateResponse>['data']>;
}

export interface HttpApiOptions {
  baseUrl: string;
  userAgent: string;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpApi implements AgentApi {
  private credential: string | null = null;
  constructor(private readonly o: HttpApiOptions) {}

  setCredential(secret: string) {
    this.credential = secret;
  }

  private async request<S extends z.ZodTypeAny>(method: 'GET' | 'POST' | 'PUT', path: string, schema: S, body?: unknown, auth = true): Promise<z.infer<S>> {
    const attempts = this.o.maxAttempts ?? 3;
    const sleep = this.o.sleep ?? defaultSleep;
    let last: ApiError | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.once(method, path, schema, body, auth);
      } catch (e) {
        if (!(e instanceof ApiError) || !e.retryable) throw e;
        last = e;
        if (i < attempts - 1) await sleep(e.retryAfterMs ?? Math.min(8000, 500 * 2 ** i) + Math.floor(Math.random() * 250));
      }
    }
    throw last ?? new ApiError(0, 'NETWORK', 'Request failed', true);
  }

  private async once<S extends z.ZodTypeAny>(method: string, path: string, schema: S, body: unknown, auth: boolean): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.o.userAgent };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (!this.credential) throw new ApiError(401, 'UNAUTHORIZED', 'This computer is not paired', false);
      headers.authorization = `Bearer ${this.credential}`;
    }
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl}${path}`, {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'The server could not be reached', true);
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page from a proxy */
    }
    if (!res.ok) {
      const env = errorEnvelope.safeParse(json);
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new ApiError(
        res.status,
        env.success ? env.data.error.code : `HTTP_${res.status}`,
        env.success ? (env.data.error.message ?? 'Request failed') : 'Request failed',
        res.status >= 500 || res.status === 429 || res.status === 408,
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : undefined
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError(res.status, 'BAD_RESPONSE', 'The server sent an unexpected response', false);
    return parsed.data;
  }

  async heartbeat(info: { appVersion: string; osVersion: string }) {
    return (await this.request('POST', '/device/heartbeat', heartbeatResponse, info)).data;
  }
  async reportPrinters(printers: PrinterReport[]) {
    return (await this.request('PUT', '/device/printers', printersResponse, { printers })).data.printers;
  }
  async claim() {
    return (await this.request('POST', '/device/print-jobs/claim', claimResponse, {})).data;
  }
  async active() {
    return (await this.request('GET', '/device/print-jobs/active', activeResponse)).data.jobs;
  }
  async download(jobId: string, leaseId: string) {
    return (await this.request('POST', `/device/print-jobs/${encodeURIComponent(jobId)}/download`, downloadResponse, { leaseId })).data;
  }
  async progress(jobId: string, report: ProgressReport) {
    return (await this.request('POST', `/device/print-jobs/${encodeURIComponent(jobId)}/progress`, progressResponse, report)).data.job;
  }
  async rotate() {
    return (await this.request('POST', '/device/credential/rotate', rotateResponse, {})).data;
  }

  /** Unauthenticated: redeem a short-lived pairing code. */
  async pair(input: { code: string; deviceName: string; appVersion: string; osVersion: string }) {
    return (await this.request('POST', '/device/pair', pairResponse, { ...input, platform: 'WINDOWS' }, false)).data;
  }
}
