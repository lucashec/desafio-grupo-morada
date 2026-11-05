import { randomUUID } from 'node:crypto';

export function validOrder(overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: 'Maria Teste', document: '12345678901', email: 'maria@example.test' },
    items: [{ sku: 'SKU-001', quantity: 2, unitPriceCents: 1990 }],
    notes: 'deliver after 6pm',
    ...overrides,
  };
}

export function newKey(): string {
  return `key-${randomUUID()}`;
}

export function jsonHeaders(idempotencyKey?: string, extra: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    ...extra,
  };
}
