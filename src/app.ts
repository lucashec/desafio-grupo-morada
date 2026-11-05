import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { CORRELATION_HEADER, resolveCorrelationId } from './http/correlation.js';
import { registerErrorHandling } from './http/errors.js';
import { registerHealthRoutes } from './http/health.routes.js';
import { registerOrderRoutes } from './http/orders.routes.js';
import type { Logger } from './logger.js';

export const BODY_LIMIT_BYTES = 32 * 1024;

export function buildApp(deps: { pool: pg.Pool; logger: Logger }) {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: resolveCorrelationId,
    logController: new LogController({ requestIdLogLabel: 'correlationId', disableRequestLogging: true }),
  });

  app.removeContentTypeParser('text/plain');

  app.addHook('onSend', async (request, reply) => {
    reply.header(CORRELATION_HEADER, request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  registerErrorHandling(app);
  registerHealthRoutes(app, deps.pool);
  registerOrderRoutes(app, deps.pool);
  return app;
}
