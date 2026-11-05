import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/orders_dev' };

describe('loadConfig', () => {
  // REQ-SEC-04
  it('loads defaults when only the required variables are set', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      databaseUrl: base.DATABASE_URL,
      port: 3000,
      maxAttempts: 5,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60000,
      erpTimeoutMs: 5000,
      erpLookupTimeoutMs: 3000,
      leaseMs: 30000,
      workerPollIntervalMs: 1000,
      workerBatchSize: 10,
      workerEnabled: true,
    });
  });

  // REQ-CONC-06
  it('rejects a lease that is not longer than the worst-case attempt plus margin', () => {
    const env = { ...base, LEASE_MS: '10000', ERP_TIMEOUT_MS: '5000', ERP_LOOKUP_TIMEOUT_MS: '3000' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/LEASE_MS must be greater than 16000/);
  });

  // REQ-CONC-06
  it('accepts a lease just above the worst-case attempt plus margin', () => {
    const env = { ...base, LEASE_MS: '16001', ERP_TIMEOUT_MS: '5000', ERP_LOOKUP_TIMEOUT_MS: '3000' };
    expect(loadConfig(env).leaseMs).toBe(16001);
  });

  // REQ-SEC-04
  it('names the invalid variable without echoing its value', () => {
    const secretLooking = 'not-a-number-s3cr3t';
    let message = '';
    try {
      loadConfig({ ...base, MAX_ATTEMPTS: secretLooking });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('MAX_ATTEMPTS');
    expect(message).not.toContain(secretLooking);
  });

  // REQ-SEC-04
  it('fails when a required variable is missing, naming it', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  // REQ-SEC-04
  it('does not echo the database URL when it is malformed', () => {
    const bad = 'mysql://user:hunter2@host/db';
    let message = '';
    try {
      loadConfig({ DATABASE_URL: bad });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('hunter2');
  });
});
