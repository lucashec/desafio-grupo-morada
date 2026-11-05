import { describe, expect, it } from 'vitest';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import { validOrder } from '../helpers/fixtures.js';
import type { OrderPayload } from '../../src/domain/order.js';

const payload = validOrder() as OrderPayload;

describe('FakeErpClient', () => {
  // REQ-ERP-09
  it('success records the order and returns its erpOrderId', async () => {
    const fake = new FakeErpClient({ scenarios: ['success'] });
    const result = await fake.createOrder('ref-1', payload);
    expect(result).toEqual({ kind: 'SUCCESS', erpOrderId: fake.registry.get('ref-1') });
    expect(fake.createdCount).toBe(1);
  });

  // REQ-ERP-09
  it('transient and permanent return errors with code/message and record nothing', async () => {
    const fake = new FakeErpClient({ scenarios: ['transient', 'permanent'] });
    expect(await fake.createOrder('ref-1', payload)).toMatchObject({ kind: 'TRANSIENT_ERROR', code: 'ERP_503' });
    expect(await fake.createOrder('ref-1', payload)).toMatchObject({ kind: 'PERMANENT_ERROR', code: 'ERP_422' });
    expect(fake.createdCount).toBe(0);
    expect(fake.registry.size).toBe(0);
  });

  // REQ-ERP-09
  it('timeout returns AMBIGUOUS{TIMEOUT} and records nothing; lookup then says NOT_FOUND', async () => {
    const fake = new FakeErpClient({ scenarios: ['timeout'] });
    expect(await fake.createOrder('ref-1', payload)).toEqual({ kind: 'AMBIGUOUS', cause: 'TIMEOUT' });
    expect(fake.createdCount).toBe(0);
    expect(await fake.lookupByReference('ref-1')).toEqual({ kind: 'NOT_FOUND' });
  });

  // REQ-ERP-09
  it('processed_then_timeout records the order but returns AMBIGUOUS{TIMEOUT}; lookup finds it', async () => {
    const fake = new FakeErpClient({ scenarios: ['processed_then_timeout'] });
    expect(await fake.createOrder('ref-1', payload)).toEqual({ kind: 'AMBIGUOUS', cause: 'TIMEOUT' });
    expect(fake.registry.has('ref-1')).toBe(true);
    expect(fake.createdCount).toBe(1);
    expect(await fake.lookupByReference('ref-1')).toEqual({ kind: 'FOUND', erpOrderId: fake.registry.get('ref-1') });
  });

  // REQ-ERP-09, REQ-ERP-11
  it('conflict_found returns AMBIGUOUS{CONFLICT}, records the reference once, and lookup finds it', async () => {
    const fake = new FakeErpClient({ scenarios: ['conflict_found'] });
    expect(await fake.createOrder('ref-1', payload)).toEqual({ kind: 'AMBIGUOUS', cause: 'CONFLICT' });
    expect(await fake.createOrder('ref-1', payload)).toEqual({ kind: 'AMBIGUOUS', cause: 'CONFLICT' });
    expect(fake.createdCount).toBe(1);
    expect(await fake.lookupByReference('ref-1')).toEqual({ kind: 'FOUND', erpOrderId: fake.registry.get('ref-1') });
  });

  // REQ-ERP-09, REQ-ERP-11
  it('conflict_found does not count again when the reference already exists', async () => {
    const fake = new FakeErpClient({ scenarios: ['success', 'conflict_found'] });
    const first = await fake.createOrder('ref-1', payload);
    expect(await fake.createOrder('ref-1', payload)).toEqual({ kind: 'AMBIGUOUS', cause: 'CONFLICT' });
    expect(fake.createdCount).toBe(1);
    expect(await fake.lookupByReference('ref-1')).toEqual(first.kind === 'SUCCESS' ? { kind: 'FOUND', erpOrderId: first.erpOrderId } : null);
  });

  // REQ-ERP-09, REQ-ERP-11
  it('conflict_not_found returns AMBIGUOUS{CONFLICT}, leaves the registry untouched, and lookup says NOT_FOUND', async () => {
    const fake = new FakeErpClient({ scenarios: ['conflict_not_found'] });
    expect(await fake.createOrder('ref-1', payload)).toEqual({ kind: 'AMBIGUOUS', cause: 'CONFLICT' });
    expect(fake.registry.size).toBe(0);
    expect(fake.createdCount).toBe(0);
    expect(await fake.lookupByReference('ref-1')).toEqual({ kind: 'NOT_FOUND' });
  });

  // REQ-ERP-09
  it('lookup scenario unknown returns UNKNOWN even when the order exists; auto answers from the registry', async () => {
    const fake = new FakeErpClient({ scenarios: ['success'], lookupScenarios: ['unknown', 'auto'] });
    await fake.createOrder('ref-1', payload);
    expect(await fake.lookupByReference('ref-1')).toMatchObject({ kind: 'UNKNOWN', code: 'ERP_503' });
    expect(await fake.lookupByReference('ref-1')).toMatchObject({ kind: 'FOUND' });
  });

  // REQ-ERP-09
  it('consumes scenarios in order and repeats the last one', async () => {
    const fake = new FakeErpClient({ scenarios: ['transient', 'success'] });
    const kinds = [];
    for (let i = 0; i < 4; i++) kinds.push((await fake.createOrder(`ref-${i}`, payload)).kind);
    expect(kinds).toEqual(['TRANSIENT_ERROR', 'SUCCESS', 'SUCCESS', 'SUCCESS']);
  });

  // REQ-ERP-09
  it('counts create calls, lookup calls and created orders separately', async () => {
    const fake = new FakeErpClient({ scenarios: ['transient', 'timeout', 'success'] });
    await fake.createOrder('ref-1', payload);
    await fake.createOrder('ref-1', payload);
    await fake.lookupByReference('ref-1');
    await fake.createOrder('ref-1', payload);
    await fake.lookupByReference('ref-1');
    expect({ createCalls: fake.createCalls, lookupCalls: fake.lookupCalls, createdCount: fake.createdCount }).toEqual({
      createCalls: 3,
      lookupCalls: 2,
      createdCount: 1,
    });
  });

  // REQ-ERP-09
  it('honorsReference=true (default) deduplicates by reference: same erpOrderId, createdCount 1', async () => {
    const fake = new FakeErpClient({ scenarios: ['success'] });
    const a = await fake.createOrder('ref-1', payload);
    const b = await fake.createOrder('ref-1', payload);
    expect(a).toEqual(b);
    expect(fake.createdCount).toBe(1);
    expect(fake.registry.size).toBe(1);
  });

  // REQ-ERP-09
  it('honorsReference=false creates a new order on every recording call', async () => {
    const fake = new FakeErpClient({ scenarios: ['success', 'processed_then_timeout'], honorsReference: false });
    const a = await fake.createOrder('ref-1', payload);
    await fake.createOrder('ref-1', payload);
    expect(fake.createdCount).toBe(2);
    expect(fake.registry.size).toBe(1);
    expect(await fake.lookupByReference('ref-1')).toEqual(a.kind === 'SUCCESS' ? { kind: 'FOUND', erpOrderId: a.erpOrderId } : null);
  });

  // REQ-ERP-09
  it('runs beforeCreateResponds after the side effect and before the response', async () => {
    const seen: Array<{ reference: string; recorded: boolean }> = [];
    const fake = new FakeErpClient({
      scenarios: ['processed_then_timeout'],
      hooks: {
        beforeCreateResponds: (reference) => {
          seen.push({ reference, recorded: fake.registry.has(reference) });
          return Promise.resolve();
        },
      },
    });
    await fake.createOrder('ref-1', payload);
    expect(seen).toEqual([{ reference: 'ref-1', recorded: true }]);
  });

  // REQ-ERP-09
  it('hang() holds the next call until released, without timers', async () => {
    const fake = new FakeErpClient();
    const release = fake.hang();
    let settled = false;
    const pending = fake.createOrder('ref-1', payload).then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.createCalls).toBe(1);
    release();
    await expect(pending).resolves.toMatchObject({ kind: 'SUCCESS' });
    // only the next call hangs
    await expect(fake.createOrder('ref-2', payload)).resolves.toMatchObject({ kind: 'SUCCESS' });
  });

  // REQ-ERP-09
  it('truncates ERP error code to 64 and message to 200 characters', async () => {
    const fake = new FakeErpClient({ scenarios: ['permanent'], errorMessage: 'x'.repeat(1000), errorCode: 'C'.repeat(100) });
    const result = await fake.createOrder('ref-1', payload);
    expect(result.kind).toBe('PERMANENT_ERROR');
    if (result.kind !== 'PERMANENT_ERROR') return;
    expect(result.code).toHaveLength(64);
    expect(result.message).toHaveLength(200);
  });
});
