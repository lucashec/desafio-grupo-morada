import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const CORRELATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const CORRELATION_HEADER = 'x-correlation-id';

/** REQ-OBS-02: accept a well-formed client correlation id, otherwise generate one. */
export function resolveCorrelationId(req: IncomingMessage): string {
  const header = req.headers[CORRELATION_HEADER];
  return typeof header === 'string' && CORRELATION_ID_RE.test(header) ? header : randomUUID();
}
