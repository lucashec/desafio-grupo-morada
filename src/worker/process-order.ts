import type pg from 'pg';
import { computeDelay } from '../domain/backoff.js';
import type { ClaimedOrder } from '../infra/db/orders.repo.js';
import { finalizeAttempt } from '../infra/db/orders.repo.js';
import type { ErpClient } from '../infra/erp/erp-client.js';
import type { Logger } from '../logger.js';

export type ProcessDeps = {
  pool: pg.Pool;
  erp: ErpClient;
  logger: Logger;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  random: () => number;
};

type FinalizeOpts = {
  to: 'SENT' | 'FAILED' | 'RETRY_SCHEDULED';
  erpOrderId?: string | null;
  lastError?: { code: string; message: string } | null;
  nextAttemptDelayMs?: number | null;
  event: { type: 'ERP_CREATE'; outcome: string; errorCode?: string | null; errorMessage?: string | null; durationMs: number };
};

/** Runs one claimed attempt; the lease is held, so the outcome can be applied. */
export async function processClaimed(deps: ProcessDeps, order: ClaimedOrder): Promise<void> {
  const started = performance.now();
  // The order id is the ERP reference: the ERP deduplicates by it (REQ-IDEM-04).
  const result = await deps.erp.createOrder(order.id, order.payload);
  const durationMs = Math.round(performance.now() - started);

  async function finalize(f: FinalizeOpts): Promise<void> {
    const { applied } = await finalizeAttempt(deps.pool, {
      orderId: order.id,
      leaseToken: order.leaseToken,
      attempt: order.attempt,
      correlationId: order.correlationId,
      nextAttemptDelayMs: null,
      ...f,
    });
    if (!applied) {
      deps.logger.warn({ orderId: order.id, attempt: order.attempt, code: 'LEASE_LOST' }, 'lease lost; result not applied');
    }
  }

  switch (result.kind) {
    case 'SUCCESS':
      await finalize({
        to: 'SENT',
        erpOrderId: result.erpOrderId,
        event: { type: 'ERP_CREATE', outcome: 'SUCCESS', durationMs },
      });
      break;
    case 'PERMANENT_ERROR':
      await finalize({
        to: 'FAILED',
        lastError: { code: 'ERP_REJECTED', message: result.message },
        event: {
          type: 'ERP_CREATE',
          outcome: 'PERMANENT_ERROR',
          errorCode: result.code,
          errorMessage: result.message,
          durationMs,
        },
      });
      break;
    case 'TRANSIENT_ERROR': {
      const event = {
        type: 'ERP_CREATE' as const,
        outcome: 'TRANSIENT_ERROR',
        errorCode: result.code,
        errorMessage: result.message,
        durationMs,
      };
      if (order.attempt < deps.maxAttempts) {
        await finalize({
          to: 'RETRY_SCHEDULED',
          lastError: { code: result.code, message: result.message },
          nextAttemptDelayMs: computeDelay(
            order.attempt,
            { baseMs: deps.retryBaseDelayMs, maxMs: deps.retryMaxDelayMs },
            deps.random,
          ),
          event,
        });
      } else {
        await finalize({ to: 'FAILED', lastError: { code: 'RETRIES_EXHAUSTED', message: result.message }, event });
      }
      break;
    }
    case 'AMBIGUOUS':
      throw new Error(`outcome not handled yet: ${result.kind} ${result.cause}`);
    default: {
      const exhaustive: never = result;
      throw new Error(`unknown create result ${String(exhaustive)}`);
    }
  }
}

