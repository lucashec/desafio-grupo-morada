import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from '../../src/domain/order.js';
import { assertTransition, canTransition, InvalidTransitionError } from '../../src/domain/state-machine.js';

const ALLOWED: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  ['PENDING', 'PROCESSING'],
  ['RETRY_SCHEDULED', 'PROCESSING'],
  ['UNCERTAIN', 'PROCESSING'],
  ['PROCESSING', 'PROCESSING'],
  ['PROCESSING', 'SENT'],
  ['PROCESSING', 'RETRY_SCHEDULED'],
  ['PROCESSING', 'FAILED'],
  ['PROCESSING', 'UNCERTAIN'],
  ['PROCESSING', 'NEEDS_REVIEW'],
  ['FAILED', 'PENDING'],
  ['NEEDS_REVIEW', 'UNCERTAIN'],
];
const allowedKeys = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));
const ALL_PAIRS = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => [from, to] as const));
const FORBIDDEN = ALL_PAIRS.filter(([from, to]) => !allowedKeys.has(`${from}->${to}`));

describe('state machine', () => {
  // REQ-STATE-01
  it.each(ALLOWED)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  // REQ-STATE-02
  it('rejects every pair outside the table (full 7x7 product)', () => {
    expect(ALL_PAIRS).toHaveLength(49);
    expect(FORBIDDEN).toHaveLength(49 - 11);
    for (const [from, to] of FORBIDDEN) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
    }
  });

  // REQ-STATE-02, REQ-STATE-04
  it('treats SENT as terminal: no transition leaves it', () => {
    for (const to of ORDER_STATUSES) {
      expect(canTransition('SENT', to)).toBe(false);
    }
  });

  // REQ-STATE-02
  it('reports both states in the error', () => {
    expect(() => assertTransition('SENT', 'PENDING')).toThrow(/SENT -> PENDING/);
  });
});
