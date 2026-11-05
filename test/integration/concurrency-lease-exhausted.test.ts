import { describe, expect, it } from 'vitest';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import { useTestDatabase } from '../helpers/db.js';
import { buildWorker, createOrder, events } from '../helpers/worker.js';

const { pool } = useTestDatabase();

describe('expired lease reclaim', () => {
  // REQ-RETRY-05, REQ-CONC-03
  it('abandons an expired lease whose attempts are exhausted to NEEDS_REVIEW without calling the ERP', async () => {
    const id = await createOrder(pool);
    await pool.query(
      `UPDATE orders SET status = 'PROCESSING', attempts = 3, lease_token = gen_random_uuid(),
          locked_until = now() - interval '1 second', next_attempt_at = NULL
       WHERE id = $1`,
      [id],
    );
    const erp = new FakeErpClient();
    const first = buildWorker(pool, { erp, maxAttempts: 3 });
    const second = buildWorker(pool, { erp, maxAttempts: 3 });

    const results = await Promise.all([first.worker.runOnce(), second.worker.runOnce()]);

    expect(results[0] + results[1]).toBe(1);
    expect(erp.createCalls).toBe(0);
    expect(erp.lookupCalls).toBe(0);
    expect(await findClaimMetrics(id)).toEqual({
      status: 'NEEDS_REVIEW',
      attempts: 4,
      lastErrorCode: 'LEASE_EXPIRED',
      leaseToken: null,
      lockedUntil: null,
    });

    const evs = await events(pool, id);
    const abandoned = evs.filter((e) => e.type === 'ATTEMPT_ABANDONED');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.attempt).toBe(4);
    expect(abandoned[0]?.to_status).toBe('NEEDS_REVIEW');
    expect(abandoned[0]?.error_code).toBe('LEASE_EXPIRED');
    expect(evs.filter((e) => e.type === 'ATTEMPT_STARTED' && e.attempt === 4)).toHaveLength(0);
  });
});

async function findClaimMetrics(id: string) {
  const { rows } = await pool.query<{
    status: string;
    attempts: number;
    lastErrorCode: string | null;
    leaseToken: string | null;
    lockedUntil: string | null;
  }>(
    `SELECT status, attempts, last_error_code AS "lastErrorCode", lease_token AS "leaseToken",
            locked_until AS "lockedUntil"
     FROM orders WHERE id = $1`,
    [id],
  );
  return rows[0];
}
