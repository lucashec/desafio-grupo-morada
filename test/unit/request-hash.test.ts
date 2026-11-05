import { describe, expect, it } from 'vitest';
import { canonicalJson, requestHash } from '../../src/domain/request-hash.js';

describe('requestHash', () => {
  // REQ-IDEM-02
  it('ignores object key order at every nesting level', () => {
    const a = { customer: { name: 'A', email: 'a@b.co' }, items: [{ sku: 'X', quantity: 1 }] };
    const b = { items: [{ quantity: 1, sku: 'X' }], customer: { email: 'a@b.co', name: 'A' } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(requestHash(a)).toBe(requestHash(b));
  });

  // REQ-IDEM-03
  it('changes when any value changes, including array order', () => {
    const base = { items: [{ sku: 'X', quantity: 1 }, { sku: 'Y', quantity: 2 }] };
    const otherQty = { items: [{ sku: 'X', quantity: 9 }, { sku: 'Y', quantity: 2 }] };
    const swapped = { items: [{ sku: 'Y', quantity: 2 }, { sku: 'X', quantity: 1 }] };
    expect(requestHash(otherQty)).not.toBe(requestHash(base));
    expect(requestHash(swapped)).not.toBe(requestHash(base));
  });

  // REQ-IDEM-02
  it('is a 64-char lowercase hex SHA-256', () => {
    expect(requestHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
