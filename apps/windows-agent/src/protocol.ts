import { z } from 'zod';

/**
 * Wire contract with the Printout Buddy API (/api/v1). Responses are validated before use: a server (or a proxy) that
 * answers with something unexpected must never be interpreted as a print instruction.
 * The API side of the same contract is covered by apps/api/test/windows-print-agent.test.ts and by
 * test/integration/engine-vs-api.test.ts (this engine against the real API).
 */
export const JOB_STATUSES = [
  'QUEUED', 'CLAIMED', 'DOWNLOADING', 'SUBMITTING', 'SUBMITTED_TO_SPOOLER', 'PRINT_INITIATED',
  'FAILED', 'CANCEL_REQUESTED', 'CANCELED', 'NEEDS_RECONCILIATION'
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type ReportStatus = 'DOWNLOADING' | 'SUBMITTING' | 'SUBMITTED_TO_SPOOLER' | 'PRINT_INITIATED' | 'FAILED' | 'CANCELED' | 'NEEDS_RECONCILIATION';

export const jobOptionsSchema = z.object({
  copies: z.number().int().min(1).max(1000),
  colourMode: z.enum(['bw', 'colour']),
  sides: z.enum(['single', 'duplex']),
  paperSize: z.string().max(40),
  pageSelection: z.union([
    z.object({ mode: z.literal('all') }),
    z.object({ mode: z.literal('ranges'), ranges: z.array(z.object({ from: z.number().int().positive(), to: z.number().int().positive() })).min(1).max(50) })
  ])
});
export type JobOptions = z.infer<typeof jobOptionsSchema>;

export const deviceJobSchema = z.object({
  id: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  orderId: z.string(),
  status: z.enum(JOB_STATUSES),
  attempt: z.number().int().min(0),
  leaseId: z.string().uuid().nullable(),
  leaseExpiresAt: z.string().nullable(),
  cancelRequested: z.boolean(),
  statusBeforeCancel: z.enum(JOB_STATUSES).nullable(),
  printer: z.object({ id: z.string(), name: z.string().min(1).max(200) }),
  options: jobOptionsSchema,
  spoolerJobId: z.number().int().nullable(),
  documentName: z.string().regex(/^pb-[A-Za-z0-9_-]+-\d+$/)
});
export type DeviceJob = z.infer<typeof deviceJobSchema>;

export const claimResponse = z.object({ data: z.object({ job: deviceJobSchema.nullable(), resumed: z.boolean() }) });
export const activeResponse = z.object({ data: z.object({ jobs: z.array(deviceJobSchema) }) });
export const progressResponse = z.object({ data: z.object({ job: deviceJobSchema }) });
export const downloadResponse = z.object({
  data: z.object({
    url: z.string().min(1).max(4096),
    expiresAt: z.string(),
    mimeType: z.string(),
    byteSize: z.number().int().nonnegative().nullable(),
    /** Verified by the agent only when it is a 64-hex SHA-256 (legacy rows may hold something else). */
    sha256: z.string().max(200).nullable()
  })
});
export const rotateResponse = z.object({
  data: z.object({ deviceCredential: z.string().startsWith('pbd_'), credentialVersion: z.number().int(), previousValidForSeconds: z.number().int() })
});
export const pairResponse = z.object({
  data: z.object({
    deviceId: z.string(),
    deviceCredential: z.string().startsWith('pbd_'),
    shop: z.object({ displayName: z.string() }),
    heartbeatIntervalSeconds: z.number().int().positive()
  })
});
export const heartbeatResponse = z.object({ data: z.object({ heartbeatIntervalSeconds: z.number().int().positive() }).passthrough() });
export const printersResponse = z.object({
  data: z.object({
    printers: z.array(z.object({ id: z.string(), name: z.string(), authorized: z.boolean(), isDefault: z.boolean(), present: z.boolean() }).passthrough())
  })
});
export const errorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string().optional(), details: z.unknown().optional() }) });

export interface PrinterReport {
  name: string;
  driverName?: string;
  connectivity: 'ONLINE' | 'OFFLINE' | 'ERROR' | 'UNKNOWN';
  statusDetail?: string;
  supportsColour: boolean;
  supportsDuplex: boolean;
  paperSizes: string[];
}

export interface ProgressReport {
  leaseId: string;
  status: ReportStatus;
  spoolerJobId?: number;
  spoolerState?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Document formats the agent can print. Anything else is rejected BEFORE the spooler is touched. */
export const SUPPORTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type SupportedMime = (typeof SUPPORTED_MIME_TYPES)[number];
