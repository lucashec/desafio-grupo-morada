import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';

function memoryStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

const DOCUMENT = '98765432100';

describe('logger redact', () => {
  // REQ-OBS-05
  it('masks customer.document when logged directly', () => {
    const { stream, lines } = memoryStream();
    const logger = createLogger({ level: 'info', stream });
    logger.info({ customer: { document: DOCUMENT } }, 'direct');
    logger.info({ order: { customer: { document: DOCUMENT } } }, 'nested');
    logger.info({ document: DOCUMENT }, 'top-level');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain(DOCUMENT);
      expect(line).toContain('[REDACTED]');
    }
  });

  // REQ-OBS-05
  it('keeps redact active through the Fastify logger instance', async () => {
    const { stream, lines } = memoryStream();
    // The pool is never touched by this test.
    const app = buildApp({ pool: {} as never, logger: createLogger({ level: 'info', stream }) });
    app.log.info({ customer: { document: DOCUMENT } }, 'via fastify');
    await app.close();
    const line = lines.find((l) => l.includes('via fastify'));
    expect(line).toBeDefined();
    expect(line).not.toContain(DOCUMENT);
    expect(JSON.parse(line!).customer).toBe('[REDACTED]');
  });
});
