import pg from 'pg';
import { afterAll, beforeEach } from 'vitest';

const DEFAULT_TEST_URL = 'postgres://orders:orders@localhost:5432/orders_test';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
}

/** Hard guard: the suite truncates tables, so it must never touch a non-test database. */
export function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against database "${dbName}": name must end in _test`);
  }
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE order_events, orders RESTART IDENTITY');
}

/**
 * Per-file test database: one pool, tables truncated before every test,
 * pool closed after the file.
 */
export function useTestDatabase(): { pool: pg.Pool } {
  const url = testDatabaseUrl();
  assertTestDatabase(url);
  const pool = new pg.Pool({ connectionString: url, max: 30 });
  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  return { pool };
}
