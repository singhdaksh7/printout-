/**
 * Device notification foundation. A notification is only a SIGNAL ("something changed, go fetch"); it is never authoritative
 * and NEVER carries document URLs, storage keys, credentials, file names or customer data. Receivers must call the Device API.
 */
export type DeviceSignalType = 'NEW_PRINT_REQUEST';

export interface DeviceSignal {
  type: DeviceSignalType;
  /** Opaque order id. The only identifier allowed in a push payload. */
  orderId: string;
}

/** Fire-and-forget hook used by the order pipeline. Must never throw into the caller. */
export interface Notifier {
  notifyNewPrintRequest(shopId: string, orderId: string): void;
}
