import { describe, expect, it } from 'vitest';
import type { OrderPayload } from '../../src/domain/order.js';
import { findOrderView } from '../../src/infra/db/orders.repo.js';
import { classifyCreate } from '../../src/infra/erp/classify.js';
import type { CreateOrderResult, ErpClient, LookupResult } from '../../src/infra/erp/erp-client.js';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import { useTestDatabase } from '../helpers/db.js';
import { buildWorker, createOrder, events, makeDue } from '../helpers/worker.js';

const { pool } = useTestDatabase();

async function runUntilStable(worker: { runOnce(): Promise<number> }, id: string, maxRounds = 10) {
  for (let i = 0; i < maxRounds; i++) {
    await worker.runOnce();
    const view = await findOrderView(pool, id);
    if (view?.status !== 'RETRY_SCHEDULED' && view?.status !== 'UNCERTAIN') return view;
    await makeDue(pool, id);
  }
  throw new Error('order did not stabilize');
}

describe('retry with backoff', () => {
  // REQ-RETRY-02, REQ-ERP-04
  it('schedules a retry in the future after one transient error', async () => {
    const id = await createOrder(pool);
    const { worker } = buildWorker(pool, { erp: new FakeErpClient({ scenarios: ['transient'] }) });

    await worker.runOnce();

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('RETRY_SCHEDULED');
    expect(view?.lastError?.code).toBe('ERP_503');
    const { rows } = await pool.query('SELECT next_attempt_at > now() AS future FROM orders WHERE id = $1', [id]);
    expect(rows[0].future).toBe(true);
    expect(await worker.runOnce()).toBe(0);
  });

  // REQ-ERP-04, REQ-RETRY-02, REQ-IDEM-04
  it('retries transient errors until success: SENT, attempts 3, one order created in the ERP (Obr-4)', async () => {
    const id = await createOrder(pool);
    const references: string[] = [];
    const erp = new FakeErpClient({
      scenarios: ['transient', 'transient', 'success'],
      hooks: {
        beforeCreateResponds: (reference) => {
          references.push(reference);
          return Promise.resolve();
        },
      },
    });
    const { worker } = buildWorker(pool, { erp });

    const view = await runUntilStable(worker, id);

    expect(view?.status).toBe('SENT');
    expect(view?.attempts).toBe(3);
    expect(erp.createCalls).toBe(3);
    expect(erp.createdCount).toBe(1);
    expect(references).toEqual([id, id, id]);
    const outcomes = (await events(pool, id)).filter((e) => e.type === 'ERP_CREATE').map((e) => e.to_status);
    expect(outcomes).toEqual(['RETRY_SCHEDULED', 'RETRY_SCHEDULED', 'SENT']);
  });

  // REQ-RETRY-03
  it('fails with RETRIES_EXHAUSTED after MAX_ATTEMPTS transient errors, keeping the ERP code in the event', async () => {
    const id = await createOrder(pool);
    const erp = new FakeErpClient({ scenarios: ['transient'] });
    const { worker } = buildWorker(pool, { erp, maxAttempts: 3 });

    const view = await runUntilStable(worker, id);

    expect(view?.status).toBe('FAILED');
    expect(view?.lastError?.code).toBe('RETRIES_EXHAUSTED');
    expect(view?.attempts).toBe(3);
    expect(view?.nextAttemptAt).toBeNull();
    expect(erp.createCalls).toBe(3);
    const last = (await events(pool, id)).filter((e) => e.type === 'ERP_CREATE').at(-1);
    expect(last).toMatchObject({ to_status: 'FAILED', outcome: 'TRANSIENT_ERROR', error_code: 'ERP_503' });
  });

  // REQ-RETRY-03, REQ-ERP-07
  it('bounds out-of-contract 3xx responses by MAX_ATTEMPTS (P-02)', async () => {
    const id = await createOrder(pool);
    let calls = 0;
    const redirecting: ErpClient = {
      createOrder(_reference: string, _payload: OrderPayload): Promise<CreateOrderResult> {
        calls++;
        const c = classifyCreate({ status: 302 });
        if (c.kind !== 'TRANSIENT_ERROR') throw new Error(`unexpected classification ${c.kind}`);
        return Promise.resolve({ kind: 'TRANSIENT_ERROR', code: 'ERP_302', message: 'redirect' });
      },
      lookupByReference(): Promise<LookupResult> {
        throw new Error('lookup must not be called for transient errors');
      },
    };
    const { worker } = buildWorker(pool, { erp: redirecting, maxAttempts: 3 });

    const view = await runUntilStable(worker, id);

    expect(view?.status).toBe('FAILED');
    expect(view?.lastError?.code).toBe('RETRIES_EXHAUSTED');
    expect(calls).toBe(3);
  });
});
