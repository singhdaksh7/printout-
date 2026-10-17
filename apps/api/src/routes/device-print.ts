import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deviceGuard, deviceOf } from '../device-auth.js';
import { rotateDeviceCredential } from '../domain/devices.js';
import { activeJobs, claimNext, issueJobDownload, reportPrinters, reportProgress } from '../domain/print-jobs.js';
import { AppError } from '../errors.js';
import { getLimiters } from '../rate-limits.js';
import { idParam, json, type AppContext } from './context.js';

// No control characters anywhere: these strings are shown in the shop UI and compared with the OS spooler.
// eslint-disable-next-line no-control-regex
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, 'control characters are not allowed');

const printersBody = z
  .object({
    printers: z
      .array(
        z
          .object({
            name: text(200),
            driverName: text(200).optional(),
            connectivity: z.enum(['ONLINE', 'OFFLINE', 'ERROR', 'UNKNOWN']),
            statusDetail: text(200).optional(),
            supportsColour: z.boolean(),
            supportsDuplex: z.boolean(),
            paperSizes: z.array(text(60)).max(80).optional()
          })
          .strict()
      )
      .max(50)
  })
  .strict();

const leaseBody = z.object({ leaseId: z.string().uuid() }).strict();
const progressBody = z
  .object({
    leaseId: z.string().uuid(),
    status: z.enum(['DOWNLOADING', 'SUBMITTING', 'SUBMITTED_TO_SPOOLER', 'PRINT_INITIATED', 'FAILED', 'CANCELED', 'NEEDS_RECONCILIATION']),
    spoolerJobId: z.number().int().min(0).max(2_147_483_647).optional(),
    spoolerState: text(80).optional(),
    errorCode: z.string().max(40).optional(),
    errorMessage: z.string().max(600).optional()
  })
  .strict();
const emptyBody = z.object({}).strict();

/**
 * Device-authenticated Windows print agent API. The authenticated device row is the ONLY tenant/device source: no shop id,
 * device id or printer owner is ever read from the body. Jobs are matched on (id, shopId, deviceId) AND the lease.
 */
export async function devicePrintRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config } = ctx;
  const limits = getLimiters(app, config);
  app.addHook('onRequest', limits.ipCeiling(config.RATE_LIMIT_SHOP_READ_MAX * 5));
  const guard = deviceGuard(ctx);
  const read = { preHandler: [guard, limits.deviceRead] };
  const mutate = { preHandler: [guard, limits.deviceMutation] };
  const windowsOnly = (request: Parameters<typeof deviceOf>[0]) => {
    const me = deviceOf(request);
    if (me.platform !== 'WINDOWS') throw new AppError(409, 'CONFLICT', 'Only Windows print agents can use the print queue');
    return me;
  };

  app.put('/device/printers', mutate, async (request) => {
    const me = windowsOnly(request);
    const body = printersBody.parse(request.body);
    const names = new Set<string>();
    for (const p of body.printers) {
      if (names.has(p.name)) throw new AppError(400, 'VALIDATION_ERROR', 'Duplicate printer name');
      names.add(p.name);
    }
    return json({ printers: await reportPrinters(ctx.prisma, me, body.printers) });
  });

  app.post('/device/print-jobs/claim', mutate, async (request) => {
    const me = windowsOnly(request);
    emptyBody.parse(request.body ?? {});
    return json(await claimNext(ctx, me));
  });

  app.get('/device/print-jobs/active', read, async (request) => {
    const me = windowsOnly(request);
    return json({ jobs: await activeJobs(ctx, me) });
  });

  app.post('/device/print-jobs/:id/download', mutate, async (request) => {
    const me = windowsOnly(request);
    const { id } = idParam.parse(request.params);
    const { leaseId } = leaseBody.parse(request.body);
    return json(await issueJobDownload(ctx, me, id, leaseId));
  });

  app.post('/device/print-jobs/:id/progress', mutate, async (request) => {
    const me = windowsOnly(request);
    const { id } = idParam.parse(request.params);
    const body = progressBody.parse(request.body);
    return json({ job: await reportProgress(ctx, me, id, body) });
  });

  app.post('/device/credential/rotate', mutate, async (request) => {
    const me = deviceOf(request);
    emptyBody.parse(request.body ?? {});
    return json(await rotateDeviceCredential(ctx.prisma, me));
  });
}
