export type ErpTransportError = 'ECONNREFUSED' | 'ECONNRESET' | 'TIMEOUT';

/** What a transport observed: either an HTTP status or a transport-level failure. */
export type RawErpResponse = { status: number } | { errorCode: ErpTransportError };

export type CreateClassification =
  | { kind: 'SUCCESS' }
  | { kind: 'TRANSIENT_ERROR' }
  | { kind: 'PERMANENT_ERROR' }
  | { kind: 'AMBIGUOUS'; cause: 'TIMEOUT' | 'CONFLICT' };

export type LookupClassification = 'FOUND' | 'NOT_FOUND' | 'UNKNOWN';

/** REQ-ERP-07: pure mapping of a createOrder response. */
export function classifyCreate(raw: RawErpResponse): CreateClassification {
  if ('errorCode' in raw) {
    return raw.errorCode === 'TIMEOUT' ? { kind: 'AMBIGUOUS', cause: 'TIMEOUT' } : { kind: 'TRANSIENT_ERROR' };
  }
  const { status } = raw;
  if (status >= 200 && status < 300) return { kind: 'SUCCESS' };
  if (status === 409) return { kind: 'AMBIGUOUS', cause: 'CONFLICT' };
  if (status === 408 || status === 429 || status >= 500) return { kind: 'TRANSIENT_ERROR' };
  if (status >= 400) return { kind: 'PERMANENT_ERROR' };
  // 1xx/3xx are not part of the ERP contract: retrying is the safe choice.
  return { kind: 'TRANSIENT_ERROR' };
}

/** REQ-ERP-07: pure mapping of a lookupByReference response. Anything not conclusive is UNKNOWN. */
export function classifyLookup(raw: RawErpResponse): LookupClassification {
  if ('errorCode' in raw) return 'UNKNOWN';
  if (raw.status >= 200 && raw.status < 300) return 'FOUND';
  if (raw.status === 404) return 'NOT_FOUND';
  return 'UNKNOWN';
}
