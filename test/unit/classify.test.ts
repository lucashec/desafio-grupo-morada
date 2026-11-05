import { describe, expect, it } from 'vitest';
import { classifyCreate, classifyLookup, type RawErpResponse } from '../../src/infra/erp/classify.js';

const cases: ReadonlyArray<[string, RawErpResponse, string, string]> = [
  // label, raw response, expected create classification, expected lookup classification
  ['200', { status: 200 }, 'SUCCESS', 'FOUND'],
  ['201', { status: 201 }, 'SUCCESS', 'FOUND'],
  ['400', { status: 400 }, 'PERMANENT_ERROR', 'UNKNOWN'],
  ['404', { status: 404 }, 'PERMANENT_ERROR', 'NOT_FOUND'],
  ['408', { status: 408 }, 'TRANSIENT_ERROR', 'UNKNOWN'],
  ['409', { status: 409 }, 'AMBIGUOUS:CONFLICT', 'UNKNOWN'],
  ['422', { status: 422 }, 'PERMANENT_ERROR', 'UNKNOWN'],
  ['429', { status: 429 }, 'TRANSIENT_ERROR', 'UNKNOWN'],
  ['500', { status: 500 }, 'TRANSIENT_ERROR', 'UNKNOWN'],
  ['503', { status: 503 }, 'TRANSIENT_ERROR', 'UNKNOWN'],
  ['ECONNREFUSED', { errorCode: 'ECONNREFUSED' }, 'TRANSIENT_ERROR', 'UNKNOWN'],
  ['ECONNRESET', { errorCode: 'ECONNRESET' }, 'TRANSIENT_ERROR', 'UNKNOWN'],
  ['TIMEOUT', { errorCode: 'TIMEOUT' }, 'AMBIGUOUS:TIMEOUT', 'UNKNOWN'],
];

describe('ERP response classification', () => {
  // REQ-ERP-07
  it.each(cases)('create %s -> %#', (_label, raw, expectedCreate) => {
    const c = classifyCreate(raw);
    expect(c.kind === 'AMBIGUOUS' ? `AMBIGUOUS:${c.cause}` : c.kind).toBe(expectedCreate);
  });

  // REQ-ERP-07
  it.each(cases)('lookup %s -> %#', (_label, raw, _create, expectedLookup) => {
    expect(classifyLookup(raw)).toBe(expectedLookup);
  });
});
