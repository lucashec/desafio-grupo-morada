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

function post(payload: unknown, key: string, rawBody?: string) {
  return app.inject({
    method: 'POST',
    url: '/orders',
    headers: jsonHeaders(key),
    payload: rawBody ?? JSON.stringify(payload),
  });
}

async function orderCount(): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
  return rows[0].n;
}

describe('idempotency', () => {
  // REQ-IDEM-03
  it('returns 422 when the same key is reused with a different payload and leaves the original intact', async () => {
    const key = newKey();
    const first = await post(validOrder(), key);
    expect(first.statusCode).toBe(202);
    const { rows: before } = await pool.query('SELECT * FROM orders');

    const changed = validOrder({ items: [{ sku: 'SKU-001', quantity: 3, unitPriceCents: 1990 }] });
    const second = await post(changed, key);

    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    const { rows: after } = await pool.query('SELECT * FROM orders');
    expect(after).toEqual(before);
  });

  // REQ-IDEM-02
  it('replays the same key and payload with 200, Idempotent-Replayed and the same id, creating nothing', async () => {
    const key = newKey();
    const first = await post(validOrder(), key);
    const replay = await post(validOrder(), key);

    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(await orderCount()).toBe(1);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM order_events WHERE type = 'CREATED'`);
    expect(rows[0].n).toBe(1);
  });

  // REQ-IDEM-02
  it('treats a payload with reordered JSON keys as the same request', async () => {
    const key = newKey();
    await post(validOrder(), key);
    const reordered =
      '{"notes":"deliver after 6pm","items":[{"unitPriceCents":1990,"quantity":2,"sku":"SKU-001"}],' +
      '"customer":{"email":"maria@example.test","document":"12345678901","name":"Maria Teste"}}';
    const replay = await post(undefined, key, reordered);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  // REQ-IDEM-02
  it('replay reflects the current status, not the original response', async () => {
    const key = newKey();
    const first = (await post(validOrder(), key)).json();
    await pool.query(`UPDATE orders SET status = 'SENT', erp_order_id = 'ERP-1' WHERE id = $1`, [first.id]);

    const replay = await post(validOrder(), key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.id, status: 'SENT' });
  });

  // REQ-IDEM-01, REQ-OBS-03
  it('never leaves an order without its CREATED event: a failing event insert rolls back the order', async () => {
    await pool.query(
      `ALTER TABLE order_events ADD CONSTRAINT test_reject_created CHECK (type <> 'CREATED') NOT VALID`,
    );
    try {
      const res = await post(validOrder(), newKey());
      expect(res.statusCode).toBe(500);
      expect(await orderCount()).toBe(0);
    } finally {
      await pool.query('ALTER TABLE order_events DROP CONSTRAINT test_reject_created');
    }
  });

  // REQ-IDEM-01
  it('does not consume the key when the payload is invalid', async () => {
    const key = newKey();
    const invalid = await post(validOrder({ items: [] }), key);
    expect(invalid.statusCode).toBe(400);
    const valid = await post(validOrder(), key);
    expect(valid.statusCode).toBe(202);
  });
});
