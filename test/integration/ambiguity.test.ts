import { describe, expect, it } from 'vitest';
import { findOrderView } from '../../src/infra/db/orders.repo.js';
import { FakeErpClient, type FakeErpOptions } from '../../src/infra/erp/fake-erp-client.js';
import { useTestDatabase } from '../helpers/db.js';
import { buildWorker, createOrder, events, makeDue } from '../helpers/worker.js';

const { pool } = useTestDatabase();

async function isFuture(id: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT next_attempt_at > now() AS future FROM orders WHERE id = $1', [id]);
  return rows[0].future === true;
}

async function runUntilStable(worker: { runOnce(): Promise<number> }, id: string, maxRounds = 10) {
  for (let i = 0; i < maxRounds; i++) {
    await worker.runOnce();
    const view = await findOrderView(pool, id);
    if (view?.status !== 'RETRY_SCHEDULED' && view?.status !== 'UNCERTAIN') return view;
    await makeDue(pool, id);
  }
  throw new Error('order did not stabilize');
}

function setup(opts: FakeErpOptions, maxAttempts = 5) {
  const erp = new FakeErpClient(opts);
  return buildWorker(pool, { erp, maxAttempts });
}

describe('ambiguous outcomes and reconciliation', () => {
  // REQ-ERP-05, REQ-ERP-06, REQ-OBS-03
  it.each([true, false])(
    'processed_then_timeout with honorsReference=%s: UNCERTAIN, then lookup FOUND -> SENT with createdCount 1 (Obr-5)',
    async (honorsReference) => {
      const id = await createOrder(pool);
      const { worker, erp } = setup({ scenarios: ['processed_then_timeout'], honorsReference });

      await worker.runOnce();
      const uncertain = await findOrderView(pool, id);
      expect(uncertain?.status).toBe('UNCERTAIN');
      expect(uncertain?.lastError?.code).toBe('ERP_TIMEOUT');
      expect(await isFuture(id)).toBe(true);
      expect(await worker.runOnce()).toBe(0);

      await makeDue(pool, id);
      await worker.runOnce();

      const view = await findOrderView(pool, id);
      expect(view?.status).toBe('SENT');
      expect(view?.erpOrderId).toBe(erp.registry.get(id));
      expect(erp.createdCount).toBe(1);
      expect({ createCalls: erp.createCalls, lookupCalls: erp.lookupCalls }).toEqual({ createCalls: 1, lookupCalls: 1 });
      expect((await events(pool, id)).map((e) => [e.type, e.attempt, e.outcome, e.to_status])).toEqual([
        ['CREATED', null, null, 'PENDING'],
        ['ATTEMPT_STARTED', 1, null, 'PROCESSING'],
        ['ERP_CREATE', 1, 'AMBIGUOUS_TIMEOUT', 'UNCERTAIN'],
        ['ATTEMPT_STARTED', 2, null, 'PROCESSING'],
        ['ERP_LOOKUP', 2, 'FOUND', 'SENT'],
      ]);
    },
  );

  // REQ-ERP-06, REQ-ERP-05
  it('AMBIGUOUS{TIMEOUT} + lookup NOT_FOUND resends in the same attempt: SENT, 2 creates, createdCount 1', async () => {
    const id = await createOrder(pool);
    const { worker, erp } = setup({ scenarios: ['timeout', 'success'] });

    const view = await runUntilStable(worker, id);

    expect(view?.status).toBe('SENT');
    expect(view?.attempts).toBe(2);
    expect({ createCalls: erp.createCalls, lookupCalls: erp.lookupCalls, createdCount: erp.createdCount }).toEqual({
      createCalls: 2,
      lookupCalls: 1,
      createdCount: 1,
    });
    const attempt2 = (await events(pool, id)).filter((e) => e.attempt === 2);
    expect(attempt2.map((e) => [e.type, e.outcome, e.from_status, e.to_status])).toEqual([
      ['ATTEMPT_STARTED', null, 'UNCERTAIN', 'PROCESSING'],
      ['ERP_LOOKUP', 'NOT_FOUND', 'PROCESSING', 'PROCESSING'],
      ['ERP_CREATE', 'SUCCESS', 'PROCESSING', 'SENT'],
    ]);
  });

  // REQ-ERP-11
  it('AMBIGUOUS{CONFLICT} + lookup NOT_FOUND does not resend: immediate NEEDS_REVIEW with attempts left', async () => {
    const id = await createOrder(pool);
    const { worker, erp } = setup({ scenarios: ['conflict_not_found'] }, 5);

    await worker.runOnce();

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('NEEDS_REVIEW');
    expect(view?.attempts).toBe(1);
    expect(view?.lastError?.code).toBe('ERP_CONFLICT_NOT_FOUND');
    expect(view?.nextAttemptAt).toBeNull();
    expect({ createCalls: erp.createCalls, lookupCalls: erp.lookupCalls, createdCount: erp.createdCount }).toEqual({
      createCalls: 1,
      lookupCalls: 1,
      createdCount: 0,
    });
    const attempt1 = (await events(pool, id)).filter((e) => e.attempt === 1 && e.type !== 'ATTEMPT_STARTED');
    expect(attempt1.map((e) => [e.type, e.outcome, e.to_status])).toEqual([
      ['ERP_CREATE', 'AMBIGUOUS_CONFLICT', 'PROCESSING'],
      ['ERP_LOOKUP', 'NOT_FOUND', 'NEEDS_REVIEW'],
    ]);
  });

  // REQ-ERP-11
  it('AMBIGUOUS{CONFLICT} + lookup FOUND -> SENT with the registered erpOrderId and createdCount 1', async () => {
    const id = await createOrder(pool);
    const { worker, erp } = setup({ scenarios: ['conflict_found'] });

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

  // REQ-ERP-11
  it('AMBIGUOUS{CONFLICT} + lookup UNKNOWN -> UNCERTAIN with a future next attempt', async () => {
    const id = await createOrder(pool);
    const { worker } = setup({ scenarios: ['conflict_not_found'], lookupScenarios: ['unknown'] });

    await worker.runOnce();

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('UNCERTAIN');
    expect(view?.lastError?.code).toBe('ERP_LOOKUP_UNKNOWN');
    expect(await isFuture(id)).toBe(true);
  });

  // REQ-ERP-06
  it('lookup UNKNOWN keeps the order UNCERTAIN and never calls createOrder again', async () => {
    const id = await createOrder(pool);
    const { worker, erp } = setup({ scenarios: ['timeout'], lookupScenarios: ['unknown'] });

    await worker.runOnce();
    expect(erp.createCalls).toBe(1);
    await makeDue(pool, id);
    await worker.runOnce();

    const view = await findOrderView(pool, id);
    expect(view?.status).toBe('UNCERTAIN');
    expect(view?.lastError?.code).toBe('ERP_LOOKUP_UNKNOWN');
    expect(await isFuture(id)).toBe(true);
    expect(erp.createCalls).toBe(1);
    expect(erp.lookupCalls).toBe(1);
  });

  // REQ-RETRY-04
  it('exhausted reconciliation goes to NEEDS_REVIEW/RECONCILIATION_EXHAUSTED: 1 create, 2 lookups', async () => {
    const id = await createOrder(pool);
    const { worker, erp } = setup({ scenarios: ['timeout'], lookupScenarios: ['unknown'] }, 3);

    const view = await runUntilStable(worker, id);

    expect(view?.status).toBe('NEEDS_REVIEW');
    expect(view?.lastError?.code).toBe('RECONCILIATION_EXHAUSTED');
    expect(view?.attempts).toBe(3);
    expect(view?.nextAttemptAt).toBeNull();
    expect(erp.createCalls).toBe(1);
    expect(erp.lookupCalls).toBe(2);
  });

  // REQ-RETRY-04, REQ-ERP-06, REQ-ERP-09
  it('honorsReference=false + lookup unavailable: NEEDS_REVIEW without resending, createdCount 1 (Obr-9)', async () => {
    const id = await createOrder(pool);
    const { worker, erp } = setup(
      { scenarios: ['processed_then_timeout'], lookupScenarios: ['unknown'], honorsReference: false },
      3,
    );

    const view = await runUntilStable(worker, id);

    expect(view?.status).toBe('NEEDS_REVIEW');
    expect(view?.lastError?.code).toBe('RECONCILIATION_EXHAUSTED');
    expect(erp.createCalls).toBe(1);
    expect(erp.lookupCalls).toBe(2);
    expect(erp.createdCount).toBe(1);
  });

  // REQ-ERP-01, REQ-ERP-06
  it('records ATTEMPT_STARTED before the lookup and the NOT_FOUND lookup event before the resend', async () => {
    const id = await createOrder(pool);
    const snapshot = async () => {
      const { rows } = await pool.query('SELECT status, attempts FROM orders WHERE id = $1', [id]);
      return { ...rows[0], events: (await events(pool, id)).map((e) => `${e.type}:${e.attempt ?? ''}:${e.outcome ?? ''}`) };
    };
    let atLookup: unknown;
    let atResend: unknown;
    const erp = new FakeErpClient({
      scenarios: ['timeout', 'success'],
      hooks: {
        beforeLookupResponds: async () => {
          atLookup = await snapshot();
        },
        beforeCreateResponds: async () => {
          if (erp.createCalls === 2) atResend = await snapshot();
        },
      },
    });
    const { worker } = buildWorker(pool, { erp });

    await worker.runOnce();
    await makeDue(pool, id);
    await worker.runOnce();

    expect(atLookup).toEqual({
      status: 'PROCESSING',
      attempts: 2,
      events: ['CREATED::', 'ATTEMPT_STARTED:1:', 'ERP_CREATE:1:AMBIGUOUS_TIMEOUT', 'ATTEMPT_STARTED:2:'],
    });
    expect(atResend).toMatchObject({ status: 'PROCESSING', attempts: 2 });
    expect((atResend as { events: string[] }).events.at(-1)).toBe('ERP_LOOKUP:2:NOT_FOUND');
  });
});
