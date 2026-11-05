import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { jsonHeaders, newKey, validOrder } from '../helpers/fixtures.js';

const { pool } = useTestDatabase();
const app = buildTestApp(pool);

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const NO_KEY = Symbol('no idempotency key');

function post(payload: unknown, key: string | typeof NO_KEY = newKey()) {
  const headers = jsonHeaders(key === NO_KEY ? undefined : key);
  return app.inject({ method: 'POST', url: '/orders', headers, payload: JSON.stringify(payload) });
}

async function countRows() {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM order_events) AS events`,
  );
  return rows[0] as { orders: number; events: number };
}

describe('POST /orders', () => {
  // REQ-API-01
  it('persists a PENDING order with a CREATED event and answers 202 with Location', async () => {
    const res = await post(validOrder());
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe('PENDING');
    expect(typeof body.createdAt).toBe('string');
    expect(res.headers.location).toBe(`/orders/${body.id}`);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(await countRows()).toEqual({ orders: 1, events: 1 });
    const { rows } = await pool.query('SELECT type, to_status FROM order_events WHERE order_id = $1', [body.id]);
    expect(rows).toEqual([{ type: 'CREATED', to_status: 'PENDING' }]);
  });

  // REQ-API-01, REQ-OBS-02
  it('stores the request correlation id on the order', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: jsonHeaders(newKey(), { 'x-correlation-id': 'corr-xyz' }),
      payload: JSON.stringify(validOrder()),
    });
    const { rows } = await pool.query('SELECT correlation_id FROM orders WHERE id = $1', [res.json().id]);
    expect(rows[0].correlation_id).toBe('corr-xyz');
  });

  // REQ-API-02, REQ-SEC-03
  it.each([
    ['empty items', validOrder({ items: [] }), 'items'],
    ['zero quantity', validOrder({ items: [{ sku: 'A', quantity: 0, unitPriceCents: 1 }] }), 'items.0.quantity'],
    ['float price', validOrder({ items: [{ sku: 'A', quantity: 1, unitPriceCents: 10.5 }] }), 'items.0.unitPriceCents'],
    ['unknown field', { ...validOrder(), discount: 10 }, ''],
    ['document with 10 digits', validOrder({ customer: { name: 'A', document: '1234567890', email: 'a@b.co' } }), 'customer.document'],
    ['invalid email', validOrder({ customer: { name: 'A', document: '12345678901', email: 'nope' } }), 'customer.email'],
    ['notes too long', validOrder({ notes: 'x'.repeat(501) }), 'notes'],
  ])('rejects %s with 400 VALIDATION_ERROR and persists nothing', async (_label, payload, path) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.map((d: { path: string }) => d.path)).toContain(path);
    expect(await countRows()).toEqual({ orders: 0, events: 0 });
  });

  // REQ-API-02
  it('does not echo received values in validation details', async () => {
    const res = await post(validOrder({ customer: { name: 'A', document: '99988877', email: 'leak@example.test' } }));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('99988877');
    expect(res.body).not.toContain('leak@example.test');
  });

  // REQ-API-03
  it('rejects a missing Idempotency-Key with 400', async () => {
    const res = await post(validOrder(), NO_KEY);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(await countRows()).toEqual({ orders: 0, events: 0 });
  });

  // REQ-API-03
  it.each([
    ['129 chars', 'k'.repeat(129)],
    ['a space', 'has space'],
    ['a forbidden char', 'key/1'],
  ])('rejects an Idempotency-Key with %s', async (_label, key) => {
    const res = await post(validOrder(), key);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  // REQ-API-03
  it('accepts an Idempotency-Key with exactly 128 allowed chars', async () => {
    const res = await post(validOrder(), 'a_B-9'.repeat(25) + 'xyz');
    expect(res.statusCode).toBe(202);
  });
});

describe('GET /orders/:id', () => {
  // REQ-API-04
  it('returns status and event history without the payload', async () => {
    const created = (await post(validOrder())).json();
    const res = await app.inject({ method: 'GET', url: `/orders/${created.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: created.id,
      status: 'PENDING',
      attempts: 0,
      erpOrderId: null,
      lastError: null,
    });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ type: 'CREATED', toStatus: 'PENDING' });
    for (const key of ['type', 'attempt', 'outcome', 'errorCode', 'durationMs', 'createdAt']) {
      expect(body.events[0]).toHaveProperty(key);
    }
    for (const forbidden of ['customer', 'document', 'email', 'notes', 'payload', 'Maria Teste', '12345678901']) {
      expect(res.body).not.toContain(forbidden);
    }
  });

  // REQ-API-05
  it.each([['abc'], [randomUUID()]])('returns 404 ORDER_NOT_FOUND for id %s', async (id) => {
    const res = await app.inject({ method: 'GET', url: `/orders/${id}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ORDER_NOT_FOUND');
  });
});
