import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { findOrderView } from '../../src/infra/db/orders.repo.js';
import { FakeErpClient, type FakeErpOptions } from '../../src/infra/erp/fake-erp-client.js';
import { useTestDatabase } from '../helpers/db.js';
import { jsonHeaders, newKey, validOrder } from '../helpers/fixtures.js';
import { captureLogs } from '../helpers/log-capture.js';
import { buildWorker, makeDue } from '../helpers/worker.js';

const { pool } = useTestDatabase();
const logs = captureLogs();
const app = buildApp({ pool, logger: logs.logger });

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const DOCUMENT = '98765432100';
const DOCUMENT_FORMATTED = '987.654.321-00';
const EMAIL = 'zelda.marker@example.test';
const NAME = 'Zelda Marcadora Unica';
const REASON = 'REASON-MARKER-7f3a';
const NOTES = 'NOTES-MARKER-91c2';
const MARKERS = [DOCUMENT, DOCUMENT_FORMATTED, EMAIL, NAME, REASON, NOTES, 'Zelda', 'zelda'];

const markedOrder = () => validOrder({ customer: { name: NAME, document: DOCUMENT, email: EMAIL }, notes: NOTES });
/** An ERP error that echoes personal data, longer than 200 characters, with the document crossing position 200. */
const ECHOING_MESSAGE = `customer ${NAME} <${EMAIL}> doc ${DOCUMENT_FORMATTED} rejected; ${'x'.repeat(150)}`;
const CROSSING_MESSAGE = `${'y'.repeat(195)}${DOCUMENT} trailing ${EMAIL}`;

function post(payload: unknown, key = newKey(), extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/orders', headers: jsonHeaders(key, extra), payload: JSON.stringify(payload) });
}

async function postOrder(extra: Record<string, string> = {}): Promise<string> {
  const res = await post(markedOrder(), newKey(), extra);
  expect(res.statusCode).toBe(202);
  return res.json().id as string;
}

async function runToEnd(opts: FakeErpOptions, maxAttempts = 3): Promise<string> {
  const id = await postOrder();
  const { worker } = buildWorker(pool, { erp: new FakeErpClient(opts), maxAttempts, logger: logs.logger });
  for (let i = 0; i < 5; i++) {
    await worker.runOnce();
    await makeDue(pool, id);
  }
  return id;
}

describe('observability and personal data', () => {
  // REQ-OBS-05, REQ-OBS-04, REQ-OBS-01
  it('no log line contains document, email, name, notes or reason across request, worker and ERP-error paths (Obr-8)', async () => {
    logs.lines.length = 0;

    // request paths: create, replay, 400 with the markers in the body, GET
    const key = newKey();
    const created = await post(markedOrder(), key);
    expect((await post(markedOrder(), key)).statusCode).toBe(200);
    expect((await post({ ...markedOrder(), unknown: EMAIL })).statusCode).toBe(400);
    expect((await post({ customer: { name: NAME, document: 'bad-' + DOCUMENT, email: EMAIL } })).statusCode).toBe(400);

    // worker paths: every fake scenario, including ERP errors that echo personal data
    const scenarios: FakeErpOptions[] = [
      { scenarios: ['success'] },
      { scenarios: ['transient', 'success'], errorMessage: ECHOING_MESSAGE },
      { scenarios: ['permanent'], errorMessage: ECHOING_MESSAGE },
      { scenarios: ['permanent'], errorMessage: CROSSING_MESSAGE },
      { scenarios: ['timeout', 'success'] },
      { scenarios: ['processed_then_timeout'] },
      { scenarios: ['conflict_found'] },
      { scenarios: ['conflict_not_found'] },
      { scenarios: ['timeout'], lookupScenarios: ['unknown'], errorMessage: ECHOING_MESSAGE },
    ];
    const ids: string[] = [];
    for (const s of scenarios) ids.push(await runToEnd(s));

    // reprocess with a marked reason, then GET everything
    const failed = ids[2]!;
    expect((await app.inject({ method: 'POST', url: `/orders/${failed}/reprocess`, headers: jsonHeaders(), payload: JSON.stringify({ reason: REASON }) })).statusCode).toBe(202);
    for (const id of [created.json().id as string, ...ids]) {
      expect((await app.inject({ method: 'GET', url: `/orders/${id}` })).statusCode).toBe(200);
    }

    // the capture really saw request and worker logs, at several levels
    const entries = logs.entries();
    expect(entries.some((e) => e.msg === 'request completed')).toBe(true);
    expect(entries.some((e) => typeof e.orderId === 'string' && e.status === 'SENT')).toBe(true);
    expect(entries.some((e) => e.code === 'ERP_REJECTED' && e.status === 'FAILED')).toBe(true);
    expect(entries.some((e) => e.code === 'ERP_503' && e.status === 'RETRY_SCHEDULED')).toBe(true);

    const output = logs.lines.join('\n');
    for (const marker of MARKERS) expect(output).not.toContain(marker);
  });

  // REQ-OBS-04
  it('an ERP message echoing personal data reaches order_events truncated and without the values', async () => {
    const id = await runToEnd({ scenarios: ['permanent'], errorMessage: ECHOING_MESSAGE });
    const crossing = await runToEnd({ scenarios: ['permanent'], errorMessage: CROSSING_MESSAGE });

    for (const orderId of [id, crossing]) {
      const { rows } = await pool.query(
        `SELECT e.error_message AS event_message, o.last_error_message AS order_message
         FROM order_events e JOIN orders o ON o.id = e.order_id
         WHERE e.order_id = $1 AND e.type = 'ERP_CREATE'`,
        [orderId],
      );
      expect(rows).toHaveLength(1);
      for (const message of [rows[0].event_message as string, rows[0].order_message as string]) {
        expect(message.length).toBeLessThanOrEqual(200);
        expect(message).toMatch(/\[REDA/); // the 200 limit may cut the placeholder itself
        for (const marker of [DOCUMENT, DOCUMENT_FORMATTED, EMAIL, NAME, 'Zelda']) expect(message).not.toContain(marker);
        expect(message).not.toMatch(/9876/);
      }
    }
  });

  // REQ-OBS-04
  it('stores a 1000-character ERP error with at most 200 characters', async () => {
    const id = await runToEnd({ scenarios: ['permanent'], errorMessage: 'e'.repeat(1000) });
    const view = await findOrderView(pool, id);
    expect(view?.lastError?.message).toHaveLength(200);
    expect(view?.events.find((e) => e.type === 'ERP_CREATE')?.errorMessage).toHaveLength(200);
  });

  // REQ-OBS-01, REQ-OBS-02
  it('every worker log about the order carries correlationId, orderId, attempt and status; the correlation id reaches the events', async () => {
    logs.lines.length = 0;
    const id = await postOrder({ 'x-correlation-id': 'abc-123' });
    const { worker } = buildWorker(pool, { erp: new FakeErpClient({ scenarios: ['transient', 'success'] }), logger: logs.logger });
    await worker.runOnce();
    await makeDue(pool, id);
    await worker.runOnce();

    const workerLogs = logs.entries().filter((e) => e.orderId === id);
    expect(workerLogs.length).toBeGreaterThanOrEqual(2);
    for (const entry of workerLogs) {
      expect(entry).toMatchObject({ correlationId: 'abc-123', orderId: id });
      expect(typeof entry.attempt).toBe('number');
      expect(typeof entry.status).toBe('string');
    }
    expect(workerLogs.map((e) => e.status)).toEqual(expect.arrayContaining(['RETRY_SCHEDULED', 'SENT']));

    const { rows } = await pool.query('SELECT DISTINCT correlation_id FROM order_events WHERE order_id = $1', [id]);
    expect(rows).toEqual([{ correlation_id: 'abc-123' }]);
  });

  // REQ-OBS-03
  it('processed_then_timeout leaves the full event trail, with duration_ms on every ERP call', async () => {
    const id = await runToEnd({ scenarios: ['processed_then_timeout'] });
    const view = await findOrderView(pool, id);
    expect(view?.events.map((e) => [e.type, e.attempt, e.outcome, e.fromStatus, e.toStatus])).toEqual([
      ['CREATED', null, null, null, 'PENDING'],
      ['ATTEMPT_STARTED', 1, null, 'PENDING', 'PROCESSING'],
      ['ERP_CREATE', 1, 'AMBIGUOUS_TIMEOUT', 'PROCESSING', 'UNCERTAIN'],
      ['ATTEMPT_STARTED', 2, null, 'UNCERTAIN', 'PROCESSING'],
      ['ERP_LOOKUP', 2, 'FOUND', 'PROCESSING', 'SENT'],
    ]);
    for (const e of view?.events ?? []) {
      if (e.type.startsWith('ERP_')) expect(typeof e.durationMs).toBe('number');
      else expect(e.durationMs).toBeNull();
    }
  });

  // REQ-OBS-05
  it('an accidental nested log is censored by the redact safety net', () => {
    logs.lines.length = 0;
    logs.logger.info({ payload: markedOrder() }, 'accidental');
    logs.logger.info({ order: { customer: { document: DOCUMENT, email: EMAIL, name: NAME } } }, 'accidental nested');
    const output = logs.lines.join('\n');
    expect(output).toContain('[REDACTED]');
    for (const marker of [DOCUMENT, EMAIL, NAME]) expect(output).not.toContain(marker);
  });
});
