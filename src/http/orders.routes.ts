import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { IDEMPOTENCY_KEY_RE, orderPayloadSchema } from '../domain/order.js';
import { findOrderView, insertOrder } from '../infra/db/orders.repo.js';
import { AppError } from './errors.js';

/** Validation details carry path + rule only, never the received value (REQ-API-02). */
function validationError(error: z.ZodError): AppError {
  const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  return new AppError(400, 'VALIDATION_ERROR', 'Request body is invalid', details);
}

function orderNotFound(): AppError {
  return new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
}

const uuidSchema = z.uuid();

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

    const order = await insertOrder(pool, {
      idempotencyKey: key,
      requestHash: '0'.repeat(64), // replaced by the canonical hash in T-05
      payload: parsed.data,
      correlationId: request.id,
    });
    return reply.status(202).header('location', `/orders/${order.id}`).send(order);
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (request) => {
    if (!uuidSchema.safeParse(request.params.id).success) throw orderNotFound();
    const view = await findOrderView(pool, request.params.id);
    if (!view) throw orderNotFound();
    return view;
  });
}
