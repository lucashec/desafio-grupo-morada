import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';

export function buildTestApp(pool: pg.Pool) {
  return buildApp({ pool, logger: createLogger({ level: 'silent' }) });
}
