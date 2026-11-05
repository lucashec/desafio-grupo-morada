import { describe, expect, it } from 'vitest';
import { claimNextOrder, findOrderView } from '../../src/infra/db/orders.repo.js';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import type { OrderPayload } from '../../src/domain/order.js';
import { useTestDatabase } from '../helpers/db.js';
import { captureLogs } from '../helpers/log-capture.js';
import { buildWorker, createOrder, events, expireLease } from '../helpers/worker.js';

const { pool } = useTestDatabase();
const CLAIM = { leaseMs: 30000, maxAttempts: 5 };

/** A worker claimed the order and died before (or right after) calling the ERP. */
async function crashAfterClaim() {
  const claim = await claimNextOrder(pool, CLAIM);
  if (claim?.kind !== 'CLAIMED') throw new Error('expected a claim');
  return claim.order;
}

describe('lease recovery and fencing', () => {
  // REQ-CONC-05
  it('reclaims an expired lease, looks up before sending, and ends SENT with createdCount 1 (Obr-7)', async () => {
    const id = await createOrder(pool);
    await crashAfterClaim();
    await expireLease(pool, id);
    const { worker, erp } = buildWorker(pool);

    await worker.runOnce();

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('SENT');
    expect(view?.attempts).toBe(2);
    expect({ lookupCalls: erp.lookupCalls, createCalls: erp.createCalls, createdCount: erp.createdCount }).toEqual({
      lookupCalls: 1,
      createCalls: 1,
      createdCount: 1,
    });
    const attempt2 = (await events(pool, id)).filter((e) => e.attempt === 2).map((e) => [e.type, e.from_status, e.outcome]);
    expect(attempt2).toEqual([
      ['ATTEMPT_STARTED', 'PROCESSING', null],
      ['ERP_LOOKUP', 'PROCESSING', 'NOT_FOUND'],
      ['ERP_CREATE', 'PROCESSING', 'SUCCESS'],
    ]);
  });

  // REQ-CONC-05
  it('crash after the ERP processed the order: reclaim finds it and never re-sends', async () => {
    const id = await createOrder(pool);
    const order = await crashAfterClaim();
    const erp = new FakeErpClient({ scenarios: ['processed_then_timeout'] });
    await erp.createOrder(order.id, order.payload as OrderPayload); // the dead worker's call
    await expireLease(pool, id);
    const { worker } = buildWorker(pool, { erp });

    await worker.runOnce();

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('SENT');
    expect(view?.erpOrderId).toBe(erp.registry.get(id));
    expect({ createCalls: erp.createCalls, lookupCalls: erp.lookupCalls, createdCount: erp.createdCount }).toEqual({
      createCalls: 1,
      lookupCalls: 1,
      createdCount: 1,
    });
  });

  // REQ-CONC-04, REQ-STATE-03
  it('fencing: a worker whose lease was taken over records LEASE_LOST and changes nothing', async () => {
    const id = await createOrder(pool);
    const logs = captureLogs();
    let bProcessed: number | undefined;
    const erp = new FakeErpClient({
      hooks: {
        // While A waits for the ERP, its lease expires and B takes the order over.
        beforeCreateResponds: async () => {
          if (bProcessed !== undefined) return;
          bProcessed = -1;
          await expireLease(pool, id);
          bProcessed = await b.worker.runOnce();
        },
      },
    });
    const a = buildWorker(pool, { erp, logger: logs.logger });
    const b = buildWorker(pool, { erp });

    await a.worker.runOnce();

    expect(bProcessed).toBe(1);
    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('SENT');
    expect(view?.attempts).toBe(2);
    expect(erp.createdCount).toBe(1);

    const evs = await events(pool, id);
    const lost = evs.filter((e) => e.error_code === 'LEASE_LOST');
    expect(lost).toEqual([
      { type: 'ERP_CREATE', from_status: 'PROCESSING', to_status: null, attempt: 1, outcome: 'SUCCESS', error_code: 'LEASE_LOST' },
    ]);
    // B's lookup applied SENT; A's late SUCCESS did not produce a second transition.
    expect(evs.filter((e) => e.to_status === 'SENT').map((e) => [e.type, e.attempt])).toEqual([['ERP_LOOKUP', 2]]);
    expect(logs.entries().some((l) => l.code === 'LEASE_LOST' && l.orderId === id && l.level === 40)).toBe(true);
  });

  // REQ-CONC-04, REQ-STATE-03
  it('fencing token: while B holds the new lease (still PROCESSING), A cannot overwrite it', async () => {
    const id = await createOrder(pool);
    let bLease: string | undefined;
    const erp = new FakeErpClient({
      hooks: {
        beforeCreateResponds: async () => {
          await expireLease(pool, id);
          const claim = await claimNextOrder(pool, CLAIM); // B claims and is still working
          if (claim?.kind === 'CLAIMED') bLease = claim.order.leaseToken;
        },
      },
    });
    const a = buildWorker(pool, { erp });

    await a.worker.runOnce();

    expect(bLease).toBeDefined();
    const { rows } = await pool.query('SELECT status, lease_token, erp_order_id FROM orders WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ status: 'PROCESSING', lease_token: bLease, erp_order_id: null });
    const lost = (await events(pool, id)).filter((e) => e.error_code === 'LEASE_LOST');
    expect(lost.map((e) => [e.type, e.attempt, e.to_status])).toEqual([['ERP_CREATE', 1, null]]);
  });

  // REQ-RETRY-05, REQ-CONC-05
  it('expired lease with attempts left (attempts=2, MAX=3) starts attempt 3 normally, with a lookup first', async () => {
    const id = await createOrder(pool);
    await pool.query(
      `UPDATE orders SET status = 'PROCESSING', attempts = 2, lease_token = gen_random_uuid(),
          locked_until = now() - interval '1 second', next_attempt_at = NULL
       WHERE id = $1`,
      [id],
    );
    const { worker, erp } = buildWorker(pool, { maxAttempts: 3 });

    await worker.runOnce();

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('SENT');
    expect(view?.attempts).toBe(3);
    expect(erp.lookupCalls).toBe(1);
    const started = (await events(pool, id)).filter((e) => e.type === 'ATTEMPT_STARTED');
    expect(started).toEqual([
      { type: 'ATTEMPT_STARTED', from_status: 'PROCESSING', to_status: 'PROCESSING', attempt: 3, outcome: null, error_code: null },
    ]);
  });
});
