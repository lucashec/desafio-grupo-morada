import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './infra/db/pool.js';
import { FakeErpClient } from './infra/erp/fake-erp-client.js';
import { createLogger } from './logger.js';
import { createWorker } from './worker/worker.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const pool = createPool(config.databaseUrl);
  const app = buildApp({ pool, logger });

  // The project has no real ERP; the fake backs the running worker (T-07).
  const worker = config.workerEnabled
    ? createWorker({
        pool,
        erp: new FakeErpClient(),
        logger,
        config: {
          maxAttempts: config.maxAttempts,
          retryBaseDelayMs: config.retryBaseDelayMs,
          retryMaxDelayMs: config.retryMaxDelayMs,
          erpTimeoutMs: config.erpTimeoutMs,
          erpLookupTimeoutMs: config.erpLookupTimeoutMs,
          leaseMs: config.leaseMs,
          workerPollIntervalMs: config.workerPollIntervalMs,
          workerBatchSize: config.workerBatchSize,
        },
      })
    : undefined;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await worker?.stop();
      await app.close();
      await pool.end();
      logger.info('shutdown complete');
    } catch (err) {
      logger.error({ errMessage: (err as Error).message }, 'error during shutdown');
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  worker?.start();
}

main().catch((err: unknown) => {
  // Config errors name variables, never values (REQ-SEC-04).
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
