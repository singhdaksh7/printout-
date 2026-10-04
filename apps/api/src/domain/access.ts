import { DocumentStatus, OrderStatus } from '@prisma/client';
import { MAX_PRESIGN_SECONDS } from '../storage/types.js';

export interface AccessDoc {
  status: DocumentStatus;
  printedAt: Date | null;
  expiresAt: Date | null;
  deleteAfter: Date | null;
}

/**
 * Decides whether a shop may be handed a temporary document URL and for how long.
 * TTL = min(MAX_PRESIGN_SECONDS, whole seconds until the earliest applicable deadline), where the deadlines are
 * deleteAfter (printed documents) and expiresAt (unprinted documents). Returns null (=> 410 DOCUMENT_UNAVAILABLE) when a
 * deadline has passed or less than one whole second remains, so a presigned URL can never outlive the document.
 */
export function documentAccessWindow(
  doc: AccessDoc,
  orderStatus: OrderStatus,
  nowMs: number
): { ttlSeconds: number; deadline: Date } | null {
  if (orderStatus === OrderStatus.CANCELLED || orderStatus === OrderStatus.EXPIRED) return null;
  const deadlines: number[] = [];
  if (doc.status === DocumentStatus.PRINTED_RETENTION) {
    if (!doc.deleteAfter) return null;
    deadlines.push(doc.deleteAfter.getTime());
  } else if (doc.status === DocumentStatus.AVAILABLE) {
    if (doc.printedAt || !doc.expiresAt) return null;
    deadlines.push(doc.expiresAt.getTime());
    if (doc.deleteAfter) deadlines.push(doc.deleteAfter.getTime());
  } else {
    return null;
  }
  const deadlineMs = Math.min(...deadlines);
  const secondsLeft = Math.floor((deadlineMs - nowMs) / 1000);
  if (secondsLeft < 1) return null;
  return { ttlSeconds: Math.min(MAX_PRESIGN_SECONDS, secondsLeft), deadline: new Date(deadlineMs) };
}
