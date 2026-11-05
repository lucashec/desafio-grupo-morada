import type pg from 'pg';
import type { OrderPayload } from '../../src/domain/order.js';
import { requestHash } from '../../src/domain/request-hash.js';
import { insertOrderIdempotent } from '../../src/infra/db/orders.repo.js';
import type { ErpClient } from '../../src/infra/erp/erp-client.js';
import { FakeErpClient } from '../../src/infra/erp/fake-erp-client.js';
import { createLogger, type Logger } from '../../src/logger.js';
import { createWorker } from '../../src/worker/worker.js';
import { newKey, validOrder } from './fixtures.js';

export async function makeDue(pool: pg.Pool, id: string): Promise<void> {
  await pool.query('UPDATE orders SET next_attempt_at = now() WHERE id = $1', [id]);
}

export async function expireLease(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(`UPDATE orders SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
}

export async function createOrder(pool: pg.Pool, overrides: Record<string, unknown> = {}): Promise<string> {
  const payload = validOrder(overrides) as OrderPayload;
  const result = await insertOrderIdempotent(pool, {
    idempotencyKey: newKey(),
    requestHash: requestHash(payload),
    payload,
    correlationId: 'test-corr',
  });
  if (result.kind !== 'CREATED') throw new Error('createOrder helper: expected a fresh order');
  return result.order.id;
}

export function buildWorker<E extends ErpClient = FakeErpClient>(
  pool: pg.Pool,
  opts: { erp?: E; maxAttempts?: number; random?: () => number; batchSize?: number; logger?: Logger } = {},
) {
  const erp = opts.erp ?? (new FakeErpClient() as unknown as E);
  const worker = createWorker({
    pool,
    erp,
    logger: opts.logger ?? createLogger({ level: 'silent' }),
    config: {
      maxAttempts: opts.maxAttempts ?? 5,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60000,
      erpTimeoutMs: 5000,
      erpLookupTimeoutMs: 3000,
      leaseMs: 30000,
      workerPollIntervalMs: 1000,
      workerBatchSize: opts.batchSize ?? 10,
    },
    random: opts.random ?? (() => 1),
  });
  return { worker, erp };
}

export async function events(pool: pg.Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT type, from_status, to_status, attempt, outcome, error_code
     FROM order_events WHERE order_id = $1 ORDER BY id`,
    [id],
  );
  return rows as Array<{
    type: string;
    from_status: string | null;
    to_status: string | null;
    attempt: number | null;
    outcome: string | null;
    error_code: string | null;
  }>;
}
