import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrderView } from '../../src/infra/db/orders.repo.js';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import { buildTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { countEvents, forceStatus } from '../helpers/reprocess.js';
import { buildWorker, createOrder } from '../helpers/worker.js';

const { pool } = useTestDatabase();
const app = buildTestApp(pool);

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

function reprocess(id: string, body?: unknown) {
  return app.inject({
    method: 'POST',
    url: `/orders/${id}/reprocess`,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
  });
}

describe('POST /orders/:id/reprocess', () => {
  // REQ-RETRY-07
  it('FAILED -> PENDING: 202, attempts reset, reason stored, previous events kept', async () => {
    const id = await createOrder(pool);
    const { worker } = buildWorker(pool, { erp: new FakeErpClient({ scenarios: ['permanent'] }) });
    await worker.runOnce();
    const before = await findOrderView(pool, id);
    expect(before?.status).toBe('FAILED');
    expect(before?.events).toHaveLength(3);

    const res = await reprocess(id, { reason: 'ERP corrigido' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id, status: 'PENDING' });
    const after = await findOrderView(pool, id);
    expect(after).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null });
    expect(after?.events.slice(0, 3)).toEqual(before?.events);
    const { rows } = await pool.query(
      `SELECT from_status, to_status, reason FROM order_events WHERE order_id = $1 AND type = 'REPROCESS_REQUESTED'`,
      [id],
    );
    expect(rows).toEqual([{ from_status: 'FAILED', to_status: 'PENDING', reason: 'ERP corrigido' }]);
  });

  // REQ-RETRY-07
  it('accepts a reprocess without a body (reason is optional)', async () => {
    const id = await createOrder(pool);
    await forceStatus(pool, id, 'FAILED');
    const res = await reprocess(id);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('PENDING');
  });

  // REQ-RETRY-07, REQ-ERP-06
  it('NEEDS_REVIEW -> UNCERTAIN without calling the ERP; the next run looks up and ends SENT with no new create', async () => {
    const id = await createOrder(pool);
    const erp = new FakeErpClient({ scenarios: ['conflict_found'] });
    erp.registry.set(id, 'ERP-EXISTING');
    await forceStatus(pool, id, 'NEEDS_REVIEW');
    const { worker } = buildWorker(pool, { erp });

    const res = await reprocess(id, { reason: 'checked with the ERP team' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id, status: 'UNCERTAIN' });
    expect({ createCalls: erp.createCalls, lookupCalls: erp.lookupCalls }).toEqual({ createCalls: 0, lookupCalls: 0 });

    await worker.runOnce();

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('SENT');
    expect(view?.erpOrderId).toBe('ERP-EXISTING');
    expect({ createCalls: erp.createCalls, lookupCalls: erp.lookupCalls, createdCount: erp.createdCount }).toEqual({
      createCalls: 0,
      lookupCalls: 1,
      createdCount: 0,
    });
  });

  // REQ-RETRY-08, REQ-STATE-04
  it.each(['PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'UNCERTAIN', 'SENT'])(
    'rejects reprocess from %s with 409 and currentStatus, without changes or events',
    async (status) => {
      const id = await createOrder(pool);
      if (status !== 'PENDING') await forceStatus(pool, id, status);
      const before = await findOrderView(pool, id);

      const res = await reprocess(id, { reason: 'try' });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: { currentStatus: status } });
      expect(await findOrderView(pool, id)).toEqual(before);
    },
  );

  // REQ-RETRY-08
  it('a repeated reprocess after acceptance answers 409 and records no new event', async () => {
    const id = await createOrder(pool);
    await forceStatus(pool, id, 'FAILED');
    expect((await reprocess(id)).statusCode).toBe(202);

    const again = await reprocess(id);

    expect(again.statusCode).toBe(409);
    expect(again.json().error.details).toEqual({ currentStatus: 'PENDING' });
    expect(await countEvents(pool, id, 'REPROCESS_REQUESTED')).toBe(1);
  });

  // REQ-RETRY-07, REQ-SEC-03
  it.each([
    ['reason with 201 characters', { reason: 'x'.repeat(201) }],
    ['empty reason', { reason: '' }],
    ['unknown field', { reason: 'ok', force: true }],
  ])('rejects an invalid body (%s) with 400 and changes nothing', async (_label, body) => {
    const id = await createOrder(pool);
    await forceStatus(pool, id, 'FAILED');

    const res = await reprocess(id, body);

    expect(res.statusCode).toBe(400);
    expect((await findOrderView(pool, id))?.status).toBe('FAILED');
    expect(await countEvents(pool, id, 'REPROCESS_REQUESTED')).toBe(0);
  });

  // REQ-RETRY-08
  it.each([randomUUID(), 'not-a-uuid'])('answers 404 for an unknown order id (%s)', async (id) => {
    const res = await reprocess(id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ORDER_NOT_FOUND');
  });
});
