import type pg from 'pg';
import { claimNextOrder, type ClaimedOrder } from '../infra/db/orders.repo.js';
import { withTimeouts } from '../infra/erp/call-with-timeout.js';
import type { ErpClient } from '../infra/erp/erp-client.js';
import type { Logger } from '../logger.js';
import { errorFields } from '../logger.js';
import { processClaimed } from './process-order.js';

export type WorkerDeps = {
  pool: pg.Pool;
  erp: ErpClient;
  logger: Logger;
  config: {
    maxAttempts: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    erpTimeoutMs: number;
    erpLookupTimeoutMs: number;
    leaseMs: number;
    workerPollIntervalMs: number;
    workerBatchSize: number;
  };
  random?: () => number;
};

export function createWorker(deps: WorkerDeps): {
  runOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
} {
  const erp = withTimeouts(deps.erp, { createMs: deps.config.erpTimeoutMs, lookupMs: deps.config.erpLookupTimeoutMs });

  async function runOnce(): Promise<number> {
    let processed = 0;
    for (let i = 0; i < deps.config.workerBatchSize; i++) {
      const claim = await claimNextOrder(deps.pool, { leaseMs: deps.config.leaseMs, maxAttempts: deps.config.maxAttempts });
      if (claim === null) break;
      if (claim.kind === 'ABANDONED') {
        deps.logger.warn(
          {
            correlationId: claim.correlationId,
            orderId: claim.orderId,
            attempt: claim.attempt,
            status: 'NEEDS_REVIEW',
            code: 'LEASE_EXPIRED',
          },
          'lease expired after the last allowed attempt',
        );
        processed++;
        continue;
      }
      const order: ClaimedOrder = claim.order;
      try {
        await processClaimed(
          {
            pool: deps.pool,
            erp,
            logger: deps.logger,
            maxAttempts: deps.config.maxAttempts,
            retryBaseDelayMs: deps.config.retryBaseDelayMs,
            retryMaxDelayMs: deps.config.retryMaxDelayMs,
            random: deps.random ?? Math.random,
          },
          order,
        );
      } catch (err) {
        deps.logger.error(
          { correlationId: order.correlationId, orderId: order.id, attempt: order.attempt, status: 'PROCESSING', ...errorFields(err) },
          'order processing failed',
        );
      }
      processed++;
    }
    return processed;
  }

  let running = false;
  let loop: Promise<void> | undefined;
  let wakeSleep: (() => void) | undefined;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = undefined;
        resolve();
      }, ms);
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = undefined;
        resolve();
      };
    });
  }

  function start(): void {
    if (running) return;
    running = true;
    loop = (async () => {
      while (running) {
        try {
          const n = await runOnce();
          if (n === 0) await sleep(deps.config.workerPollIntervalMs);
        } catch (err) {
          deps.logger.error(errorFields(err), 'worker loop failed');
          await sleep(deps.config.workerPollIntervalMs);
        }
      }
    })();
  }

  async function stop(): Promise<void> {
    running = false;
    wakeSleep?.();
    if (loop) await loop;
  }

  return { runOnce, start, stop };
}
