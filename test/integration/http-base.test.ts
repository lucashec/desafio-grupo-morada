import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.js';
import { testDatabaseUrl, useTestDatabase } from '../helpers/db.js';

const { pool } = useTestDatabase();
const app = buildTestApp(pool);

app.get('/__boom', async () => {
  throw new Error('internal detail: relation "orders" password=hunter2');
});
app.post('/__echo', async (request) => ({ received: request.body !== undefined }));

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  // REQ-API-06
  it('returns 200 when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  // REQ-API-06
  it('returns 503 when the database is unavailable', async () => {
    const deadPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    await deadPool.end();
    const deadApp = buildTestApp(deadPool);
    const res = await deadApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await deadApp.close();
  });
});

describe('error format', () => {
  // REQ-API-07
  it('turns unexpected errors into 500 INTERNAL_ERROR without stack or internal message', async () => {
    const res = await app.inject({ method: 'GET', url: '/__boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(res.body).not.toContain('stack');
    expect(res.body).not.toContain('hunter2');
  });

  // REQ-API-07
  it('answers unknown routes in the standard error format', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  // REQ-API-07
  it('rejects malformed JSON with 400 in the standard format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MALFORMED_REQUEST');
  });
});

describe('request limits', () => {
  // REQ-SEC-01
  it('rejects bodies larger than 32 KB with 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(40 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  // REQ-SEC-02
  it('rejects non-JSON content types with 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__echo',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('correlation id', () => {
  // REQ-OBS-02
  it('echoes a valid X-Correlation-Id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'abc-123' },
    });
    expect(res.headers['x-correlation-id']).toBe('abc-123');
  });

  // REQ-OBS-02
  it('replaces an invalid X-Correlation-Id with a generated UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'bad id; drop table' },
    });
    expect(res.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // REQ-OBS-02
  it('generates a correlation id when none is sent', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-correlation-id']).toBeTypeOf('string');
  });
});
