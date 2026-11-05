import type pg from 'pg';
import { computeAmbiguousDelay, computeDelay } from '../domain/backoff.js';
import { safeErpMessage } from '../domain/scrub.js';
import type { ClaimedOrder } from '../infra/db/orders.repo.js';
import { finalizeAttempt, recordErpCall, type AttemptEvent } from '../infra/db/orders.repo.js';
import type { ErpClient, LookupResult } from '../infra/erp/erp-client.js';
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
  to: 'SENT' | 'FAILED' | 'RETRY_SCHEDULED' | 'UNCERTAIN' | 'NEEDS_REVIEW';
  erpOrderId?: string | null;
  lastError?: { code: string; message: string } | null;
  nextAttemptDelayMs?: number | null;
  event: AttemptEvent;
};

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await fn();
  return [result, Math.round(performance.now() - started)];
}

export async function processClaimed(deps: ProcessDeps, order: ClaimedOrder): Promise<void> {
  const backoff = { baseMs: deps.retryBaseDelayMs, maxMs: deps.retryMaxDelayMs };
  const log = deps.logger.child({ correlationId: order.correlationId, orderId: order.id, attempt: order.attempt });

  const customer = order.payload.customer;
  const safe = (message: string | null | undefined) =>
    message === null || message === undefined ? message : safeErpMessage(message, customer);
  const safeEvent = (e: AttemptEvent): AttemptEvent => ({ ...e, errorMessage: safe(e.errorMessage) });

  async function finalize(f: FinalizeOpts): Promise<void> {
    const { applied } = await finalizeAttempt(deps.pool, {
      orderId: order.id,
      leaseToken: order.leaseToken,
      attempt: order.attempt,
      correlationId: order.correlationId,
      nextAttemptDelayMs: null,
      ...f,
      lastError: f.lastError ? { code: f.lastError.code, message: safe(f.lastError.message) ?? '' } : null,
      event: safeEvent(f.event),
    });
    if (!applied) {
      log.warn({ status: 'PROCESSING', code: 'LEASE_LOST' }, 'lease lost; result not applied');
      return;
    }
    log.info({ status: f.to, outcome: f.event.outcome, code: f.lastError?.code }, 'attempt finished');
  }

  async function record(event: AttemptEvent): Promise<void> {
    await recordErpCall(deps.pool, {
      orderId: order.id,
      leaseToken: order.leaseToken,
      attempt: order.attempt,
      correlationId: order.correlationId,
      event: safeEvent(event),
    });
  }

  log.info({ status: 'PROCESSING', prevStatus: order.prevStatus }, 'attempt started');

  async function ambiguousFail(lastError: { code: string; message: string }, event: AttemptEvent): Promise<void> {
    if (order.attempt < deps.maxAttempts) {
      await finalize({
        to: 'UNCERTAIN',
        lastError,
        nextAttemptDelayMs: computeAmbiguousDelay(order.attempt, backoff, deps.random),
        event,
      });
    } else {
      await finalize({
        to: 'NEEDS_REVIEW',
        lastError: { code: 'RECONCILIATION_EXHAUSTED', message: `${lastError.code}: ${lastError.message}` },
        event,
      });
    }
  }

  async function lookup(): Promise<[LookupResult, AttemptEvent]> {
    const [result, durationMs] = await timed(() => deps.erp.lookupByReference(order.id));
    const event: AttemptEvent =
      result.kind === 'UNKNOWN'
        ? { type: 'ERP_LOOKUP', outcome: 'UNKNOWN', errorCode: result.code, errorMessage: result.message, durationMs }
        : { type: 'ERP_LOOKUP', outcome: result.kind, durationMs };
    return [result, event];
  }

  if (order.prevStatus === 'UNCERTAIN' || order.prevStatus === 'PROCESSING') {
    const [found, event] = await lookup();
    switch (found.kind) {
      case 'FOUND':
        await finalize({ to: 'SENT', erpOrderId: found.erpOrderId, event });
        return;
      case 'NOT_FOUND':
        await record(event);
        break;
      case 'UNKNOWN':
        await ambiguousFail({ code: 'ERP_LOOKUP_UNKNOWN', message: found.message }, event);
        return;
      default: {
        const exhaustive: never = found;
        throw new Error(`unknown lookup result ${String(exhaustive)}`);
      }
    }
  }

  const [result, durationMs] = await timed(() => deps.erp.createOrder(order.id, order.payload));

  switch (result.kind) {
    case 'SUCCESS':
      await finalize({
        to: 'SENT',
        erpOrderId: result.erpOrderId,
        event: { type: 'ERP_CREATE', outcome: 'SUCCESS', durationMs },
      });
      return;
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
      return;
    case 'TRANSIENT_ERROR': {
      const event: AttemptEvent = {
        type: 'ERP_CREATE',
        outcome: 'TRANSIENT_ERROR',
        errorCode: result.code,
        errorMessage: result.message,
        durationMs,
      };
      if (order.attempt < deps.maxAttempts) {
        await finalize({
          to: 'RETRY_SCHEDULED',
          lastError: { code: result.code, message: result.message },
          nextAttemptDelayMs: computeDelay(order.attempt, backoff, deps.random),
          event,
        });
      } else {
        await finalize({ to: 'FAILED', lastError: { code: 'RETRIES_EXHAUSTED', message: result.message }, event });
      }
      return;
    }
    case 'AMBIGUOUS': {
      if (result.cause === 'TIMEOUT') {
        await ambiguousFail(
          { code: 'ERP_TIMEOUT', message: 'ERP create timed out; outcome unknown' },
          { type: 'ERP_CREATE', outcome: 'AMBIGUOUS_TIMEOUT', durationMs },
        );
        return;
      }
      await record({ type: 'ERP_CREATE', outcome: 'AMBIGUOUS_CONFLICT', durationMs });
      const [found, event] = await lookup();
      switch (found.kind) {
        case 'FOUND':
          await finalize({ to: 'SENT', erpOrderId: found.erpOrderId, event });
          return;
        case 'NOT_FOUND':
          await finalize({
            to: 'NEEDS_REVIEW',
            lastError: { code: 'ERP_CONFLICT_NOT_FOUND', message: 'ERP reported a conflict but the lookup found no order' },
            event,
          });
          return;
        case 'UNKNOWN':
          await ambiguousFail({ code: 'ERP_LOOKUP_UNKNOWN', message: found.message }, event);
          return;
        default: {
          const exhaustive: never = found;
          throw new Error(`unknown lookup result ${String(exhaustive)}`);
        }
      }
    }
    default: {
      const exhaustive: never = result;
      throw new Error(`unknown create result ${String(exhaustive)}`);
    }
  }
}
