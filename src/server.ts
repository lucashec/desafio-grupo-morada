import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './infra/db/pool.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const pool = createPool(config.databaseUrl);
  const app = buildApp({ pool, logger });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
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
}

main().catch((err: unknown) => {
  // Config errors name variables, never values (REQ-SEC-04).
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
