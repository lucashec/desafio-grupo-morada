import { Writable } from 'node:stream';
import { createLogger, type Logger } from '../../src/logger.js';

/** Captures every line the real pino logger writes, in memory (no console patching). */
export function captureLogs(level = 'trace'): { logger: Logger; lines: string[]; entries: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString().split('\n').filter((l) => l.length > 0));
      cb();
    },
  });
  const logger = createLogger({ level, stream });
  return { logger, lines, entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}
