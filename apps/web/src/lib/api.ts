// Shared fetch client. Owned by the lead; areas import it but do not edit it (ask lead for changes).
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
}
let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => { csrfToken = t; };
export const getCsrfToken = () => csrfToken;

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method, headers, credentials: 'include', signal: init.signal ?? null,
      body: init.body !== undefined ? JSON.stringify(init.body) : null
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(res.status, err?.code ?? 'REQUEST_ERROR', err?.message ?? `Request failed (${res.status})`, err?.details, err?.requestId);
  }
  return json.data as T;
}
