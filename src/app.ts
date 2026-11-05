import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { CORRELATION_HEADER, resolveCorrelationId } from './http/correlation.js';
import { registerErrorHandling } from './http/errors.js';
import { registerHealthRoutes } from './http/health.routes.js';
import { registerOrderRoutes } from './http/orders.routes.js';
import type { Logger } from './logger.js';

export const BODY_LIMIT_BYTES = 32 * 1024; // REQ-SEC-01

export function buildApp(deps: { pool: pg.Pool; logger: Logger }) {
  const app = Fastify({
    // pino's Logger is structurally wider than FastifyBaseLogger; narrowing keeps
    // FastifyInstance at its default generics so route modules type-check.
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: BODY_LIMIT_BYTES,
    // The request id *is* the correlation id; request.log carries it automatically.
    genReqId: resolveCorrelationId,
    // Built-in request logging would log URLs/headers; we log a minimal line ourselves.
    logController: new LogController({ requestIdLogLabel: 'correlationId', disableRequestLogging: true }),
  });

  // REQ-SEC-02: JSON only. Fastify parses text/plain by default.
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
