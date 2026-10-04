export interface Storage {
  /** Streams `body` into private storage under a server-generated key. Never buffers the whole file; enforces maxBytes while streaming. */
  put(key: string, body: NodeJS.ReadableStream, opts: { maxBytes: number; contentType?: string }): Promise<{ size: number; sha256: string }>;
  head(key: string): Promise<{ size: number } | null>;
  openRead(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream>;
  temporaryReadUrl(key: string, expiresSeconds: number, opts?: { contentType?: string; filename?: string }): Promise<{ url: string; expiresAt: Date }>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Subset of the app Config that the storage layer needs. Extra keys are ignored. */
export interface StorageConfig {
  STORAGE_DRIVER?: 'local' | 's3';
  LOCAL_UPLOAD_DIR?: string;
  SESSION_SECRET: string;
  /** Optional dedicated secret for signed URLs/upload tokens; falls back to a SESSION_SECRET-derived key. */
  STORAGE_URL_SECRET?: string;
  /** Public path prefix of the API as seen by the browser (default /api/v1). */
  API_PREFIX?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE?: boolean | string;
}

/** Error raised for storage-level conditions that are not request validation (e.g. key collision). */
export class StorageError extends Error {
  constructor(
    public readonly code: 'KEY_EXISTS' | 'INVALID_KEY' | 'IO',
    message: string
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
