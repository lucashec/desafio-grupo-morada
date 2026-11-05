import { describe, expect, it } from 'vitest';
import { computeAmbiguousDelay, computeDelay } from '../../src/domain/backoff.js';

const cfg = { baseMs: 1000, maxMs: 60000 };

describe('exponential backoff with full jitter', () => {
  // REQ-RETRY-01
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [10, 60000],
  ])('random=1, attempt %i -> %i ms (upper bound, capped)', (attempt, expected) => {
    expect(computeDelay(attempt, cfg, () => 1)).toBe(expected);
  });

  // REQ-RETRY-01
  it.each([1, 2, 3, 10])('random=0, attempt %i -> 0 ms', (attempt) => {
    expect(computeDelay(attempt, cfg, () => 0)).toBe(0);
  });

  // REQ-RETRY-01
  it('spreads delays uniformly inside the window (random=0.5 -> half of the cap)', () => {
    expect(computeDelay(3, cfg, () => 0.5)).toBe(2000);
  });

  // REQ-RETRY-01
  it('applies the base-delay floor to ambiguous reconciliation', () => {
    expect(computeAmbiguousDelay(1, cfg, () => 0)).toBe(1000);
    expect(computeAmbiguousDelay(3, cfg, () => 1)).toBe(4000);
  });
});
