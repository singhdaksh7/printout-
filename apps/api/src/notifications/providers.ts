import type { PushProvider, PushResult } from './provider.js';
import type { DeviceSignal } from './types.js';

/** Unconfigured provider (no Firebase): sends nothing. */
export class NoopPushProvider implements PushProvider {
  async send(): Promise<PushResult> {
    return { ok: false };
  }
}

/** Test provider: records every send; can be told to fail, throw, or report tokens invalid. */
export class RecordingPushProvider implements PushProvider {
  readonly sent: Array<{ token: string; payload: DeviceSignal }> = [];
  invalidTokens = new Set<string>();
  mode: 'ok' | 'fail' | 'throw' = 'ok';

  async send(token: string, payload: DeviceSignal): Promise<PushResult> {
    this.sent.push({ token, payload });
    if (this.mode === 'throw') throw new Error(`provider exploded for ${token}`);
    if (this.mode === 'fail') return { ok: false };
    if (this.invalidTokens.has(token)) return { ok: false, invalidToken: true };
    return { ok: true };
  }
}
