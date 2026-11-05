import pg from 'pg';
import { migrate } from '../src/infra/db/migrate.js';
import { assertTestDatabase, testDatabaseUrl } from './helpers/db.js';

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  assertTestDatabase(url);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
