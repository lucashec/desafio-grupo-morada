import type pg from 'pg';
import type { OrderPayload, OrderStatus } from '../../domain/order.js';

// All SQL of the system lives here, always parameterized (REQ-SEC-03).

export type CreatedOrder = { id: string; status: OrderStatus; createdAt: Date };

/** Inserts the order and its CREATED event in a single statement. */
export async function insertOrder(
  pool: pg.Pool,
  input: { idempotencyKey: string; requestHash: string; payload: OrderPayload; correlationId: string },
): Promise<CreatedOrder> {
  const { rows } = await pool.query<{ id: string; status: OrderStatus; created_at: Date }>(
    `WITH ins AS (
       INSERT INTO orders (idempotency_key, request_hash, payload, correlation_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, status, created_at, correlation_id
     ), ev AS (
       INSERT INTO order_events (order_id, type, to_status, correlation_id)
       SELECT id, 'CREATED', status, correlation_id FROM ins
     )
     SELECT id, status, created_at FROM ins`,
    [input.idempotencyKey, input.requestHash, input.payload, input.correlationId],
  );
  const row = rows[0]!;
  return { id: row.id, status: row.status, createdAt: row.created_at };
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
