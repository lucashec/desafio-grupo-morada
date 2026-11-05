import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callWithTimeout, withTimeouts } from '../../src/infra/erp/call-with-timeout.js';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import { validOrder } from '../helpers/fixtures.js';
import type { OrderPayload } from '../../src/domain/order.js';

const payload = validOrder() as OrderPayload;
const CREATE_MS = 5000;
const LOOKUP_MS = 3000;

describe('client-side ERP timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // REQ-ERP-08
  it('turns a create that outlives ERP_TIMEOUT_MS into AMBIGUOUS{TIMEOUT}', async () => {
    const fake = new FakeErpClient();
    const release = fake.hang();
    const client = withTimeouts(fake, { createMs: CREATE_MS, lookupMs: LOOKUP_MS });

    const pending = client.createOrder('ref-1', payload);
    await vi.advanceTimersByTimeAsync(CREATE_MS);

    await expect(pending).resolves.toEqual({ kind: 'AMBIGUOUS', cause: 'TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
    release();
  });

  // REQ-ERP-08
  it('turns a lookup that outlives ERP_LOOKUP_TIMEOUT_MS into UNKNOWN{ERP_LOOKUP_TIMEOUT}', async () => {
    const fake = new FakeErpClient();
    const release = fake.hang();
    const client = withTimeouts(fake, { createMs: CREATE_MS, lookupMs: LOOKUP_MS });

    const pending = client.lookupByReference('ref-1');
    await vi.advanceTimersByTimeAsync(LOOKUP_MS);

    const result = await pending;
    expect(result.kind).toBe('UNKNOWN');
    expect(result).toMatchObject({ code: 'ERP_LOOKUP_TIMEOUT' });
    release();
  });

  // REQ-ERP-08
  it('does not fire before the deadline: just under the limit the call is still pending', async () => {
    const fake = new FakeErpClient();
    const release = fake.hang();
    const client = withTimeouts(fake, { createMs: CREATE_MS, lookupMs: LOOKUP_MS });
    let settled = false;

    const pending = client.createOrder('ref-1', payload).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(CREATE_MS - 1);
    expect(settled).toBe(false);

    release();
    await expect(pending).resolves.toMatchObject({ kind: 'SUCCESS' });
  });

  // REQ-ERP-08
  it('clears the timer when the call resolves first', async () => {
    const fake = new FakeErpClient();
    const client = withTimeouts(fake, { createMs: CREATE_MS, lookupMs: LOOKUP_MS });

    await expect(client.createOrder('ref-1', payload)).resolves.toMatchObject({ kind: 'SUCCESS' });
    await expect(client.lookupByReference('ref-1')).resolves.toMatchObject({ kind: 'FOUND' });
    expect(vi.getTimerCount()).toBe(0);
  });

  // REQ-ERP-08
  it('clears the timer and propagates when the call rejects', async () => {
    const boom = new Error('boom');
    await expect(callWithTimeout(() => Promise.reject(boom), CREATE_MS, () => 'late')).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });
});
