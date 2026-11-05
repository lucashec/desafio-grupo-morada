import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/infra/db/migrate.js';
import { assertTestDatabase, useTestDatabase } from '../helpers/db.js';

const { pool } = useTestDatabase();

async function insertOrder(key: string): Promise<void> {
  await pool.query(
    `INSERT INTO orders (idempotency_key, request_hash, payload, correlation_id)
     VALUES ($1, $2, '{}'::jsonb, 'corr')`,
    [key, 'a'.repeat(64)],
  );
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  return err as { code?: string; constraint?: string };
}

describe('schema', () => {
  // REQ-IDEM-01
  it('rejects a second order with the same idempotency key at the database level', async () => {
    await insertOrder('key-1');
    const err = await insertOrder('key-1').catch((e: unknown) => e);
    expect(pgError(err).code).toBe('23505');
    expect(pgError(err).constraint).toBe('orders_idempotency_key_uq');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    expect(rows[0].n).toBe(1);
  });

  // REQ-STATE-03
  it('rejects PROCESSING without a lease', async () => {
    await insertOrder('key-2');
    const err = await pool
      .query(`UPDATE orders SET status = 'PROCESSING' WHERE idempotency_key = 'key-2'`)
      .catch((e: unknown) => e);
    expect(pgError(err).code).toBe('23514');
    expect(pgError(err).constraint).toBe('orders_processing_has_lease_ck');
  });

  // REQ-STATE-03
  it('rejects SENT without an erp_order_id', async () => {
    await insertOrder('key-3');
    const err = await pool
      .query(`UPDATE orders SET status = 'SENT' WHERE idempotency_key = 'key-3'`)
      .catch((e: unknown) => e);
    expect(pgError(err).code).toBe('23514');
    expect(pgError(err).constraint).toBe('orders_sent_has_erp_id_ck');
  });

  // REQ-STATE-03
  it('rejects an unknown status value', async () => {
    await insertOrder('key-4');
    const err = await pool
      .query(`UPDATE orders SET status = 'DONE' WHERE idempotency_key = 'key-4'`)
      .catch((e: unknown) => e);
    expect(pgError(err).constraint).toBe('orders_status_ck');
  });

  it('refuses to use a database whose name does not end in _test', () => {
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/orders_dev')).toThrow(/_test/);
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/orders_test')).not.toThrow();
  });

  it('is idempotent: running migrations again applies nothing', async () => {
    const applied = await migrate(pool);
    expect(applied).toEqual([]);
  });
});
