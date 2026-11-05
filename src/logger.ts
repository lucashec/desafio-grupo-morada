import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Safety net only: the primary rule is to never hand payloads or personal data to
 * the logger. Anything that slips through under these keys is censored.
 */
export const REDACT_PATHS = [
  'payload',
  '*.payload',
  'body',
  '*.body',
  'customer',
  '*.customer',
  // pino wildcards match exactly one level, so top-level keys need their own entry.
  'document',
  '*.document',
  'email',
  '*.email',
  '*.name',
  'notes',
  '*.notes',
  'reason',
  '*.reason',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(opts: { level: string; stream?: DestinationStream }): Logger {
  return pino(
    {
      level: opts.level,
      base: undefined,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    opts.stream,
  );
}

export type { Logger };
