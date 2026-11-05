import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { claimNextOrder, finalizeAttempt, findOrderView } from '../../src/infra/db/orders.repo.js';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import { useTestDatabase } from '../helpers/db.js';
import { buildWorker, createOrder } from '../helpers/worker.js';

const { pool } = useTestDatabase();

describe('worker outcomes', () => {
  // REQ-ERP-02, REQ-IDEM-04
  it('sends a due order to the ERP, records the ERP order id and a SUCCESS event', async () => {
    const id = await createOrder(pool);
    const { worker, erp } = buildWorker(pool);

    const processed = await worker.runOnce();

    expect(processed).toBe(1);
    expect(erp.createCalls).toBe(1);
    expect(erp.createdCount).toBe(1);

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('SENT');
    expect(view?.erpOrderId).toBe(erp.registry.get(id));

    const ev = view?.events.find((e) => e.type === 'ERP_CREATE');
    expect(ev).toBeDefined();
    expect(ev?.fromStatus).toBe('PROCESSING');
    expect(ev?.toStatus).toBe('SENT');
    expect(ev?.outcome).toBe('SUCCESS');
    expect(ev?.durationMs).not.toBeNull();
  });

  // REQ-ERP-03
  it('marks a permanently rejected order as FAILED and does not retry it', async () => {
    const id = await createOrder(pool);
    const erp = new FakeErpClient({ scenarios: ['permanent'] });
    const { worker } = buildWorker(pool, { erp });

    await worker.runOnce();
    await worker.runOnce(); // a retried run must find nothing left to do

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('FAILED');
    expect(view?.lastError?.code).toBe('ERP_REJECTED');
    expect(view?.nextAttemptAt).toBeNull();
    expect(erp.createCalls).toBe(1);

    const ev = view?.events.find((e) => e.type === 'ERP_CREATE');
    expect(ev?.outcome).toBe('PERMANENT_ERROR');
    expect(ev?.errorCode).toBe('ERP_422');
  });

  // REQ-ERP-01
  it('claims the order (PROCESSING, attempt 1) before the ERP is called', async () => {
    const id = await createOrder(pool);
    let seen:
      | {
          status: string;
          attempts: number;
          started: number;
          fromStatus: string | null;
          attempt: number | null;
        }
      | undefined;
    const erp = new FakeErpClient({
      hooks: {
        beforeCreateResponds: async () => {
          const { rows } = await pool.query<{
            status: string;
            attempts: number;
            started: number;
          }>(
            `SELECT status, attempts,
                    (SELECT count(*)::int FROM order_events e
                      WHERE e.order_id = o.id AND e.type = 'ATTEMPT_STARTED') AS started
             FROM orders o WHERE o.id = $1`,
            [id],
          );
          const claim = rows[0]!;
          const { rows: startedEvents } = await pool.query<{ from_status: string; attempt: number }>(
            `SELECT from_status, attempt FROM order_events
             WHERE order_id = $1 AND type = 'ATTEMPT_STARTED' ORDER BY id DESC LIMIT 1`,
            [id],
          );
          const started = startedEvents[0]!;
          seen = {
            status: claim.status,
            attempts: claim.attempts,
            started: claim.started,
            fromStatus: started.from_status,
            attempt: started.attempt,
          };
        },
      },
    });
    const { worker } = buildWorker(pool, { erp });

    await worker.runOnce();

    expect(seen).toEqual({ status: 'PROCESSING', attempts: 1, started: 1, fromStatus: 'PENDING', attempt: 1 });
  });

  // REQ-RETRY-06
  it('leaves a RETRY_SCHEDULED order with a future next_attempt_at untouched', async () => {
    const id = await createOrder(pool);
    await pool.query(
      `UPDATE orders SET status = 'RETRY_SCHEDULED', next_attempt_at = now() + interval '1 hour' WHERE id = $1`,
      [id],
    );
    const { worker, erp } = buildWorker(pool);

    const processed = await worker.runOnce();

    expect(processed).toBe(0);
    expect(erp.createCalls).toBe(0);

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('RETRY_SCHEDULED');
  });

  // REQ-STATE-04
  it('never reprocesses a SENT order', async () => {
    const id = await createOrder(pool);
    await pool.query(
      `UPDATE orders SET status = 'SENT', erp_order_id = 'ERP-X', next_attempt_at = now() WHERE id = $1`,
      [id],
    );
    const { worker, erp } = buildWorker(pool);

    const processed = await worker.runOnce();

    expect(processed).toBe(0);
    expect(erp.createCalls).toBe(0);
    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('SENT');
  });

  // REQ-IDEM-04
  it('uses the order id as the ERP reference for every order', async () => {
    const references: string[] = [];
    const erp = new FakeErpClient({
      hooks: { beforeCreateResponds: async (reference) => {
        references.push(reference);
      } },
    });
    const { worker } = buildWorker(pool, { erp });

    const ids = [await createOrder(pool), await createOrder(pool), await createOrder(pool)];
    await worker.runOnce();
    await worker.runOnce();

    expect(references).toHaveLength(3);
    expect([...new Set(references)].sort()).toEqual([...new Set(ids)].sort());
  });

  // REQ-STATE-03
  it('does not apply a finalize when the lease token does not match', async () => {
    const id = await createOrder(pool);
    const claim = await claimNextOrder(pool, { leaseMs: 30000, maxAttempts: 5 });
    expect(claim?.kind).toBe('CLAIMED');
    if (claim?.kind !== 'CLAIMED') return;
    expect(claim.order.id).toBe(id);

    const result = await finalizeAttempt(pool, {
      orderId: id,
      leaseToken: randomUUID(), // not the token the claim granted
      attempt: 1,
      correlationId: 'test-corr',
      to: 'SENT',
      erpOrderId: 'ERP-X',
      lastError: null,
      nextAttemptDelayMs: null,
      event: { type: 'ERP_CREATE', outcome: 'SUCCESS', durationMs: 7 },
    });

    expect(result.applied).toBe(false);

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('PROCESSING');
    const evs = view?.events ?? [];
    expect(evs.some((e) => e.toStatus === null && e.errorCode === 'LEASE_LOST')).toBe(true);
    expect(evs.some((e) => e.toStatus === 'SENT')).toBe(false);
  });
});
