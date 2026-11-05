import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { errorFields } from '../logger.js';

export function registerHealthRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch (err) {
      request.log.warn(errorFields(err), 'health check failed');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
}
