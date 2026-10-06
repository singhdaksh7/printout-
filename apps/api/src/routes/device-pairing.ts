import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PairingAttemptCeiling, redeemPairingCode } from '../domain/devices.js';
import { AppError } from '../errors.js';
import { getLimiters, rateLimitedError } from '../rate-limits.js';
import { json, type AppContext } from './context.js';

const pairBody = z
  .object({
    code: z.string().min(1).max(40),
    deviceName: z.string().trim().min(1).max(60),
    platform: z.enum(['ANDROID', 'WINDOWS']),
    appVersion: z.string().trim().max(40).optional(),
    osVersion: z.string().trim().max(80).optional()
  })
  .strict();

/** PUBLIC pairing endpoint: POST /device/pair (code -> device + one-time credential). Owner: Agent 1. */
export async function devicePairingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { prisma, config } = ctx;
  const limits = getLimiters(app, config);
  const ceiling = new PairingAttemptCeiling();

  app.post('/device/pair', { preHandler: limits.devicePair }, async (request, reply) => {
    if (ceiling.blocked()) {
      reply.header('retry-after', '60');
      throw rateLimitedError();
    }
    const body = pairBody.parse(request.body);
    try {
      return json(
        await redeemPairingCode(prisma, config, {
          code: body.code,
          deviceName: body.deviceName,
          platform: body.platform,
          appVersion: body.appVersion,
          osVersion: body.osVersion
        })
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'PAIRING_CODE_INVALID') ceiling.recordFailure();
      throw error;
    }
  });
}
