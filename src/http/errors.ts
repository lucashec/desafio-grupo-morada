import type { FastifyError, FastifyInstance } from 'fastify';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

function body(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** REQ-API-07: one error shape; never leak stack traces or internal messages. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    const status = err.statusCode;
    if (status === 413) {
      return reply.status(413).send(body('PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit'));
    }
    if (status === 415) {
      return reply
        .status(415)
        .send(body('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(400).send(body('MALFORMED_REQUEST', 'Malformed request'));
    }
    request.log.error({ errName: err.name, errMessage: err.message }, 'unhandled error');
    return reply.status(500).send(body('INTERNAL_ERROR', 'Internal server error'));
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(body('NOT_FOUND', 'Route not found'));
  });
}
