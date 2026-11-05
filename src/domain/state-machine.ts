import type { OrderStatus } from './order.js';

export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING: ['PROCESSING'],
  RETRY_SCHEDULED: ['PROCESSING'],
  UNCERTAIN: ['PROCESSING'],
  PROCESSING: ['PROCESSING', 'SENT', 'RETRY_SCHEDULED', 'FAILED', 'UNCERTAIN', 'NEEDS_REVIEW'],
  FAILED: ['PENDING'],
  NEEDS_REVIEW: ['UNCERTAIN'],
  SENT: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Invalid order status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
