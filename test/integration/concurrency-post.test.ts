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

function post(payload: unknown, key: string) {
  return app.inject({ method: 'POST', url: '/orders', headers: jsonHeaders(key), payload: JSON.stringify(payload) });
}

async function counts() {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM orders) AS orders,
            (SELECT count(*)::int FROM order_events WHERE type = 'CREATED') AS created`,
  );
  return rows[0] as { orders: number; created: number };
}

describe('concurrent POST /orders', () => {
  // REQ-CONC-01, REQ-IDEM-01
  it('creates exactly one order for N=20 concurrent requests with the same key and payload', async () => {
    const N = 20;
    const key = newKey();
    const responses = await Promise.all(Array.from({ length: N }, () => post(validOrder(), key)));

    const created = responses.filter((r) => r.statusCode === 202);
    const replayed = responses.filter((r) => r.statusCode === 200);
    expect(created).toHaveLength(1);
    expect(created[0]!.headers['idempotent-replayed']).toBeUndefined();
    expect(replayed).toHaveLength(N - 1);
    for (const r of replayed) expect(r.headers['idempotent-replayed']).toBe('true');

    const ids = new Set(responses.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(await counts()).toEqual({ orders: 1, created: 1 });
  });

  // REQ-CONC-02, REQ-IDEM-03
  it('creates one order and answers 422 to every divergent payload when P1 and P2 race on one key', async () => {
    const N = 10;
    const key = newKey();
    const p1 = validOrder();
    const p2 = validOrder({ items: [{ sku: 'SKU-OTHER', quantity: 1, unitPriceCents: 100 }] });
    const sent = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? p1 : p2));
    const responses = await Promise.all(sent.map((p) => post(p, key)));

    expect(await counts()).toEqual({ orders: 1, created: 1 });
    const { rows } = await pool.query('SELECT payload FROM orders');
    const winner = rows[0].payload.items[0].sku === 'SKU-001' ? p1 : p2;

    responses.forEach((res, i) => {
      if (sent[i] === winner) expect([200, 202]).toContain(res.statusCode);
      else expect(res.statusCode).toBe(422);
    });
    expect(responses.filter((r) => r.statusCode === 202)).toHaveLength(1);
  });
});
