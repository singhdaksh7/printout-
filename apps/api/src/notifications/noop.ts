import type { Notifier } from './types.js';

/** Default notifier: does nothing (no Firebase configured). */
export class NoopNotifier implements Notifier {
  notifyNewPrintRequest(): void {}
}
