import { AppError } from '../errors.js';

export type OrderStatus = 'NEW' | 'ACCEPTED' | 'PRINTING' | 'PRINTED' | 'READY' | 'COLLECTED' | 'CANCELLED' | 'EXPIRED';

/** Full lifecycle graph. PRINTING -> PRINTED is only reachable through print-confirmation. */
const transitions: Record<OrderStatus, OrderStatus[]> = {
  NEW: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: ['PRINTING', 'CANCELLED', 'EXPIRED'],
  PRINTING: ['PRINTED', 'EXPIRED'],
  PRINTED: ['READY'],
  READY: ['COLLECTED'],
  COLLECTED: [],
  CANCELLED: [],
  EXPIRED: []
};

export const TERMINAL_STATUSES: OrderStatus[] = ['COLLECTED', 'CANCELLED', 'EXPIRED'];

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => transitions[from].includes(to);

/** Edges only the system (retention worker) may take; never exposed via the shop transitions route. */
const SYSTEM_ONLY = new Set(['PRINTING->EXPIRED']);

/** Transitions a shop user may request directly. PRINTED is excluded: it is set only by print-confirmation. */
export const canRequestTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  to !== 'PRINTED' && !SYSTEM_ONLY.has(`${from}->${to}`) && canTransition(from, to);

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `Invalid order transition: ${from} -> ${to}`, { from, to });
  }
}

export function assertRequestedTransition(from: OrderStatus, to: OrderStatus): void {
  if (to === 'PRINTED') {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'PRINTED is set only by print confirmation', { from, to });
  }
  if (!canRequestTransition(from, to)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `Invalid order transition: ${from} -> ${to}`, { from, to });
  }
}

export function retentionDates(now: Date, minutes: number) {
  return { printedAt: now, deleteAfter: new Date(now.getTime() + minutes * 60_000) };
}
