import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const CORRELATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const CORRELATION_HEADER = 'x-correlation-id';

export function resolveCorrelationId(req: IncomingMessage): string {
  const header = req.headers[CORRELATION_HEADER];
  return typeof header === 'string' && CORRELATION_ID_RE.test(header) ? header : randomUUID();
}
