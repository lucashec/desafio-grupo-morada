import { describe, expect, it } from 'vitest';
import { findOrderView } from '../../src/infra/db/orders.repo.js';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import { useTestDatabase } from '../helpers/db.js';
import { buildWorker, createOrder, events } from '../helpers/worker.js';

const { pool } = useTestDatabase();

describe('concurrent worker claims', () => {
  // REQ-CONC-03
  it('exactly one worker claims each order: one ERP create, one ATTEMPT_STARTED, final SENT', async () => {
    for (let i = 0; i < 10; i++) {
      const id = await createOrder(pool);
      const erp = new FakeErpClient();
      const first = buildWorker(pool, { erp });
      const second = buildWorker(pool, { erp });

      const results = await Promise.all([first.worker.runOnce(), second.worker.runOnce()]);

      expect(results[0] + results[1]).toBe(1);
      expect(erp.createCalls).toBe(1);
      const view = await findOrderView(pool, id);
      expect(view?.status).toBe('SENT');
      const started = (await events(pool, id)).filter((e) => e.type === 'ATTEMPT_STARTED');
      expect(started).toHaveLength(1);
    }
  });

  // REQ-CONC-03
  it('a racing worker that tries to claim the same order gets nothing (deterministic)', async () => {
    const id = await createOrder(pool);
    let raced: number | undefined;
    const erp = new FakeErpClient({
      hooks: {
        // Re-entrant: while the first worker holds the lease, a second worker
        // must find the order unclaimable and process zero orders.
        beforeCreateResponds: async () => {
          raced = await second.worker.runOnce();
        },
      },
    });
    const first = buildWorker(pool, { erp });
    const second = buildWorker(pool, { erp });

    const processed = await first.worker.runOnce();

    expect(processed).toBe(1);
    expect(raced).toBe(0);
    expect(erp.createCalls).toBe(1);

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('SENT');
  });

  // REQ-CONC-03
  it('SKIP LOCKED: a row locked by another transaction is skipped without blocking the worker', async () => {
    const first = await createOrder(pool);
    const second = await createOrder(pool);
    const { worker, erp } = buildWorker(pool);

    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [first]);

      const processed = await worker.runOnce();

      expect(processed).toBe(1);
      expect(erp.createCalls).toBe(1);

      const firstView = await findOrderView(pool, first);
      expect(firstView?.status).toBe('PENDING');
      const secondView = await findOrderView(pool, second);
      expect(secondView?.status).toBe('SENT');
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
});
