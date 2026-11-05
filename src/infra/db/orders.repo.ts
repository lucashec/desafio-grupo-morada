import type pg from 'pg';
import { assertTransition } from '../../domain/state-machine.js';
import type { OrderPayload, OrderStatus } from '../../domain/order.js';

// All SQL of the system lives here, always parameterized (REQ-SEC-03).

export type CreatedOrder = { id: string; status: OrderStatus; createdAt: Date };

export type InsertResult =
  | { kind: 'CREATED'; order: CreatedOrder }
  | { kind: 'REPLAYED'; order: CreatedOrder }
  | { kind: 'KEY_REUSED' };

/**
 * REQ-IDEM-01..03, REQ-CONC-01/02. Atomic insert-or-nothing guarded by the UNIQUE
 * constraint; the CREATED event is part of the same statement. On conflict the
 * INSERT waits for the competing transaction, so the follow-up SELECT (new
 * statement, new snapshot) always sees the committed winner. No SELECT-then-INSERT.
 */
export async function insertOrderIdempotent(
  pool: pg.Pool,
  input: { idempotencyKey: string; requestHash: string; payload: OrderPayload; correlationId: string },
): Promise<InsertResult> {
  const inserted = await pool.query<{ id: string; status: OrderStatus; created_at: Date }>(
    `WITH ins AS (
       INSERT INTO orders (idempotency_key, request_hash, payload, correlation_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, status, created_at, correlation_id
     ), ev AS (
       INSERT INTO order_events (order_id, type, to_status, correlation_id)
       SELECT id, 'CREATED', status, correlation_id FROM ins
     )
     SELECT id, status, created_at FROM ins`,
    [input.idempotencyKey, input.requestHash, input.payload, input.correlationId],
  );
  const row = inserted.rows[0];
  if (row) return { kind: 'CREATED', order: { id: row.id, status: row.status, createdAt: row.created_at } };

  const existing = await pool.query<{ id: string; status: OrderStatus; created_at: Date; request_hash: string }>(
    'SELECT id, status, created_at, request_hash FROM orders WHERE idempotency_key = $1',
    [input.idempotencyKey],
  );
  const found = existing.rows[0];
  if (!found) {
    // Only possible if the row were deleted between the two statements; orders are never deleted.
    throw new Error('idempotency conflict without an existing row');
  }
  if (found.request_hash !== input.requestHash) return { kind: 'KEY_REUSED' };
  return { kind: 'REPLAYED', order: { id: found.id, status: found.status, createdAt: found.created_at } };
}

export type OrderView = {
  id: string;
  status: OrderStatus;
  attempts: number;
  erpOrderId: string | null;
  lastError: { code: string; message: string | null } | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  events: Array<{
    type: string;
    fromStatus: string | null;
    toStatus: string | null;
    attempt: number | null;
    outcome: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    durationMs: number | null;
    createdAt: Date;
  }>;
};

/** REQ-API-04: status + history. Never selects the payload. */
export async function findOrderView(pool: pg.Pool, id: string): Promise<OrderView | null> {
  const { rows } = await pool.query(
    `SELECT id, status, attempts, erp_order_id, last_error_code, last_error_message,
            next_attempt_at, created_at, updated_at
     FROM orders WHERE id = $1`,
    [id],
  );
  const o = rows[0];
  if (!o) return null;
  const events = await pool.query(
    `SELECT type, from_status, to_status, attempt, outcome, error_code, error_message, duration_ms, created_at
     FROM order_events WHERE order_id = $1 ORDER BY id`,
    [id],
  );
  return {
    id: o.id,
    status: o.status,
    attempts: o.attempts,
    erpOrderId: o.erp_order_id,
    lastError: o.last_error_code ? { code: o.last_error_code, message: o.last_error_message } : null,
    nextAttemptAt: o.next_attempt_at,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    events: events.rows.map((e) => ({
      type: e.type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      attempt: e.attempt,
      outcome: e.outcome,
      errorCode: e.error_code,
      errorMessage: e.error_message,
      durationMs: e.duration_ms,
      createdAt: e.created_at,
    })),
  };
}

// Storage bounds mirror the schema: varchar(64) / varchar(200) (REQ-OBS-04).
const clamp = (s: string | null | undefined, max: number): string | null =>
  s === null || s === undefined ? null : s.slice(0, max);

export type ClaimedOrder = {
  id: string;
  payload: OrderPayload;
  attempt: number;
  leaseToken: string;
  correlationId: string;
  prevStatus: OrderStatus;
};

export type ClaimResult =
  | { kind: 'CLAIMED'; order: ClaimedOrder }
  | { kind: 'ABANDONED'; orderId: string; attempt: number };

/**
 * REQ-RETRY-05, REQ-CONC-03: atomically claims the oldest due order in one
 * short transaction. No external I/O happens inside (the ERP is only called
 * after COMMIT). Concurrency is bounded by `FOR UPDATE SKIP LOCKED`.
 */
export async function claimNextOrder(
  pool: pg.Pool,
  opts: { leaseMs: number; maxAttempts: number },
): Promise<ClaimResult | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query<{
      id: string;
      payload: OrderPayload;
      attempts: number;
      lease_token: string;
      correlation_id: string;
      prev_status: OrderStatus;
    }>(
      `WITH next AS (
         SELECT id, status AS prev_status
         FROM orders
         WHERE (status IN ('PENDING','RETRY_SCHEDULED','UNCERTAIN') AND next_attempt_at <= now())
            OR (status = 'PROCESSING' AND locked_until < now())
         ORDER BY COALESCE(next_attempt_at, locked_until)
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE orders o
       SET status = 'PROCESSING', attempts = o.attempts + 1,
           lease_token = gen_random_uuid(),
           locked_until = now() + make_interval(secs => $1 / 1000.0),
           next_attempt_at = NULL, updated_at = now()
       FROM next WHERE o.id = next.id
       RETURNING o.id, o.payload, o.attempts, o.lease_token, o.correlation_id, next.prev_status`,
      [opts.leaseMs],
    );
    const row = claimed.rows[0];
    if (!row) {
      // Nothing due right now.
      await client.query('COMMIT');
      return null;
    }

    // Case B: an expired lease on the last allowed attempt. Reclaiming would
    // mean re-sending an order the ERP may already have; route to review
    // instead of risking duplicates (REQ-RETRY-05). No ATTEMPT_STARTED.
    if (row.prev_status === 'PROCESSING' && row.attempts > opts.maxAttempts) {
      assertTransition('PROCESSING', 'NEEDS_REVIEW');
      const abandoned = await client.query(
        `UPDATE orders
         SET status = 'NEEDS_REVIEW', last_error_code = 'LEASE_EXPIRED',
             last_error_message = 'lease expired after the last allowed attempt',
             lease_token = NULL, locked_until = NULL, next_attempt_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [row.id, row.lease_token],
      );
      if (abandoned.rowCount === 1) {
        await client.query(
          `INSERT INTO order_events
             (order_id, type, from_status, to_status, attempt, error_code, lease_token, correlation_id)
           VALUES ($1, 'ATTEMPT_ABANDONED', 'PROCESSING', 'NEEDS_REVIEW', $2, 'LEASE_EXPIRED', $3, $4)`,
          [row.id, row.attempts, row.lease_token, row.correlation_id],
        );
      }
      await client.query('COMMIT');
      return { kind: 'ABANDONED', orderId: row.id, attempt: row.attempts };
    }

    // Case A: a normal claim. The start of the attempt is recorded before any
    // ERP call (REQ-ERP-01).
    assertTransition(row.prev_status, 'PROCESSING');
    await client.query(
      `INSERT INTO order_events
         (order_id, type, from_status, to_status, attempt, lease_token, correlation_id)
       VALUES ($1, 'ATTEMPT_STARTED', $2, 'PROCESSING', $3, $4, $5)`,
      [row.id, row.prev_status, row.attempts, row.lease_token, row.correlation_id],
    );
    await client.query('COMMIT');
    return {
      kind: 'CLAIMED',
      order: {
        id: row.id,
        payload: row.payload,
        attempt: row.attempts,
        leaseToken: row.lease_token,
        correlationId: row.correlation_id,
        prevStatus: row.prev_status,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type AttemptEvent = {
  type: 'ERP_CREATE' | 'ERP_LOOKUP';
  outcome: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs: number;
};

export type Finalize = {
  orderId: string;
  leaseToken: string;
  attempt: number;
  correlationId: string;
  to: OrderStatus; // SENT | RETRY_SCHEDULED | FAILED | UNCERTAIN | NEEDS_REVIEW
  erpOrderId?: string | null;
  lastError?: { code: string; message: string } | null;
  nextAttemptDelayMs?: number | null; // null/undefined -> next_attempt_at NULL
  event: AttemptEvent;
};

/**
 * REQ-STATE-03: applies the outcome of an attempt only while the caller still
 * owns the lease. A stale worker (lost lease) records LEASE_LOST but changes
 * nothing, so a late ERP result can never overwrite a newer one.
 */
export async function finalizeAttempt(pool: pg.Pool, f: Finalize): Promise<{ applied: boolean }> {
  assertTransition('PROCESSING', f.to);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE orders
       SET status = $1, erp_order_id = COALESCE($2, erp_order_id),
           last_error_code = $3, last_error_message = $4,
           next_attempt_at = CASE WHEN $5::int IS NULL THEN NULL
                                  ELSE now() + make_interval(secs => $5 / 1000.0) END,
           lease_token = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $6 AND status = 'PROCESSING' AND lease_token = $7`,
      [
        f.to,
        f.erpOrderId ?? null,
        clamp(f.lastError?.code, 64),
        clamp(f.lastError?.message, 200),
        f.nextAttemptDelayMs ?? null,
        f.orderId,
        f.leaseToken,
      ],
    );
    if (updated.rowCount === 1) {
      await client.query(
        `INSERT INTO order_events
           (order_id, type, from_status, to_status, attempt, outcome, error_code, error_message, duration_ms, lease_token, correlation_id)
         VALUES ($1, $2, 'PROCESSING', $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          f.orderId,
          f.event.type,
          f.to,
          f.attempt,
          f.event.outcome,
          clamp(f.event.errorCode, 64),
          clamp(f.event.errorMessage, 200),
          f.event.durationMs,
          f.leaseToken,
          f.correlationId,
        ],
      );
      await client.query('COMMIT');
      return { applied: true };
    }
    // Lease lost: the transition was not applied, so to_status stays NULL (REQ-STATE-03).
    await client.query(
      `INSERT INTO order_events
         (order_id, type, from_status, to_status, attempt, outcome, error_code, error_message, duration_ms, lease_token, correlation_id)
       VALUES ($1, $2, 'PROCESSING', NULL, $3, $4, 'LEASE_LOST', $5, $6, $7, $8)`,
      [
        f.orderId,
        f.event.type,
        f.attempt,
        f.event.outcome,
        clamp(f.event.errorCode, 200),
        f.event.durationMs,
        f.leaseToken,
        f.correlationId,
      ],
    );
    await client.query('COMMIT');
    return { applied: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Informational event for intermediate ERP calls that change no status. */
export async function recordErpCall(
  pool: pg.Pool,
  input: { orderId: string; leaseToken: string; attempt: number; correlationId: string; event: AttemptEvent },
): Promise<void> {
  await pool.query(
    `INSERT INTO order_events
       (order_id, type, from_status, to_status, attempt, outcome, error_code, error_message, duration_ms, lease_token, correlation_id)
     VALUES ($1, $2, 'PROCESSING', 'PROCESSING', $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.orderId,
      input.event.type,
      input.attempt,
      input.event.outcome,
      clamp(input.event.errorCode, 64),
      clamp(input.event.errorMessage, 200),
      input.event.durationMs,
      input.leaseToken,
      input.correlationId,
    ],
  );
}
