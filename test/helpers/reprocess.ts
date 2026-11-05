import type pg from 'pg';

export async function forceStatus(pool: pg.Pool, id: string, status: string): Promise<void> {
  const processing = status === 'PROCESSING';
  await pool.query(
    `UPDATE orders SET status = $2, attempts = 3,
        lease_token = CASE WHEN $3 THEN gen_random_uuid() END,
        locked_until = CASE WHEN $3 THEN now() + interval '1 minute' END,
        erp_order_id = CASE WHEN $2 = 'SENT' THEN 'ERP-X' END,
        last_error_code = CASE WHEN $2 IN ('FAILED', 'NEEDS_REVIEW') THEN 'SOME_ERROR' END,
        last_error_message = CASE WHEN $2 IN ('FAILED', 'NEEDS_REVIEW') THEN 'previous failure' END,
        next_attempt_at = CASE WHEN $2 IN ('RETRY_SCHEDULED', 'UNCERTAIN') THEN now() + interval '1 hour' END
     WHERE id = $1`,
    [id, status, processing],
  );
}

export async function countEvents(pool: pg.Pool, id: string, type: string): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND type = $2', [
    id,
    type,
  ]);
  return rows[0].n as number;
}
