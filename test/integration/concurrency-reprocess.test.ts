import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrderView } from '../../src/infra/db/orders.repo.js';
import { buildTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { countEvents, forceStatus } from '../helpers/reprocess.js';
import { createOrder } from '../helpers/worker.js';

const { pool } = useTestDatabase();
const app = buildTestApp(pool);

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('concurrent reprocess', () => {
  // REQ-RETRY-07, REQ-RETRY-08
  it.each([
    ['FAILED', 'PENDING'],
    ['NEEDS_REVIEW', 'UNCERTAIN'],
  ])('N=10 concurrent reprocess from %s: exactly one 202, nine 409, one event, final %s', async (from, to) => {
    const N = 10;
    const id = await createOrder(pool);
    await forceStatus(pool, id, from);

    const responses = await Promise.all(
      Array.from({ length: N }, () => app.inject({ method: 'POST', url: `/orders/${id}/reprocess` })),
    );

    const accepted = responses.filter((r) => r.statusCode === 202);
    const rejected = responses.filter((r) => r.statusCode === 409);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) expect(r.json().error.details).toEqual({ currentStatus: to });
    expect(await countEvents(pool, id, 'REPROCESS_REQUESTED')).toBe(1);
    expect((await findOrderView(pool, id))?.status).toBe(to);
  });
});
