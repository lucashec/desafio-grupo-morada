import pino, { type DestinationStream, type Logger } from 'pino';

export const REDACT_PATHS = [
  'payload',
  '*.payload',
  'body',
  '*.body',
  'customer',
  '*.customer',
  'document',
  '*.document',
  '*.*.document',
  'email',
  '*.email',
  '*.*.email',
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

export function errorFields(err: unknown): { errName: string; errCode?: string } {
  if (!(err instanceof Error)) return { errName: typeof err };
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? { errName: err.name, errCode: code } : { errName: err.name };
}

export type { Logger };
