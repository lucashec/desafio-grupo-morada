import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}
