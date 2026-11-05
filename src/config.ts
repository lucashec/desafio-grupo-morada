import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LEASE_SAFETY_MARGIN_MS = 5000;

const intMs = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  RETRY_BASE_DELAY_MS: intMs(1000),
  RETRY_MAX_DELAY_MS: intMs(60000),
  ERP_TIMEOUT_MS: intMs(5000),
  ERP_LOOKUP_TIMEOUT_MS: intMs(3000),
  LEASE_MS: intMs(30000),
  WORKER_POLL_INTERVAL_MS: intMs(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(`Invalid or missing environment variables: ${names.join(', ')}`);
  }
  const e = parsed.data;

  const minLease = e.ERP_TIMEOUT_MS + 2 * e.ERP_LOOKUP_TIMEOUT_MS + LEASE_SAFETY_MARGIN_MS;
  if (e.LEASE_MS <= minLease) {
    throw new ConfigError(
      `LEASE_MS must be greater than ${minLease} ` +
        '(ERP_TIMEOUT_MS + 2 * ERP_LOOKUP_TIMEOUT_MS + 5000) so a lease cannot expire mid-attempt',
    );
  }
  if (e.RETRY_MAX_DELAY_MS < e.RETRY_BASE_DELAY_MS) {
    throw new ConfigError('RETRY_MAX_DELAY_MS must be >= RETRY_BASE_DELAY_MS');
  }

  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    maxAttempts: e.MAX_ATTEMPTS,
    retryBaseDelayMs: e.RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: e.RETRY_MAX_DELAY_MS,
    erpTimeoutMs: e.ERP_TIMEOUT_MS,
    erpLookupTimeoutMs: e.ERP_LOOKUP_TIMEOUT_MS,
    leaseMs: e.LEASE_MS,
    workerPollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
    workerBatchSize: e.WORKER_BATCH_SIZE,
    workerEnabled: e.WORKER_ENABLED === 'true',
  };
}
