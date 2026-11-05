import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { IDEMPOTENCY_KEY_RE, orderPayloadSchema } from '../domain/order.js';
import { requestHash } from '../domain/request-hash.js';
import { findOrderView, insertOrderIdempotent, requestReprocess } from '../infra/db/orders.repo.js';
import { AppError } from './errors.js';

function validationError(error: z.ZodError): AppError {
  const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  return new AppError(400, 'VALIDATION_ERROR', 'Request body is invalid', details);
}

function orderNotFound(): AppError {
  return new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
}

const uuidSchema = z.uuid();

const reprocessBodySchema = z.strictObject({ reason: z.string().min(1).max(200).optional() });

export function registerOrderRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post('/orders', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_RE.test(key)) {
      throw new AppError(
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key header is required: 1-128 chars of [A-Za-z0-9_-]',
      );
    }
    const parsed = orderPayloadSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);

    const result = await insertOrderIdempotent(pool, {
      idempotencyKey: key,
      requestHash: requestHash(parsed.data),
      payload: parsed.data,
      correlationId: request.id,
    });
    switch (result.kind) {
      case 'CREATED':
        return reply.status(202).header('location', `/orders/${result.order.id}`).send(result.order);
      case 'REPLAYED':
        return reply
          .status(200)
          .header('location', `/orders/${result.order.id}`)
          .header('idempotent-replayed', 'true')
          .send(result.order);
      case 'KEY_REUSED':
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different payload',
        );
    }
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (request) => {
    if (!uuidSchema.safeParse(request.params.id).success) throw orderNotFound();
    const view = await findOrderView(pool, request.params.id);
    if (!view) throw orderNotFound();
    return view;
  });

  app.post<{ Params: { id: string } }>('/orders/:id/reprocess', async (request, reply) => {
    if (!uuidSchema.safeParse(request.params.id).success) throw orderNotFound();
    const parsed = reprocessBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw validationError(parsed.error);

    const result = await requestReprocess(pool, { id: request.params.id, reason: parsed.data.reason ?? null });
    switch (result.kind) {
      case 'ACCEPTED':
        return reply.status(202).send({ id: request.params.id, status: result.status });
      case 'INVALID_STATE':
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'Only FAILED or NEEDS_REVIEW orders can be reprocessed', {
          currentStatus: result.currentStatus,
        });
      case 'NOT_FOUND':
        throw orderNotFound();
    }
  });
}
