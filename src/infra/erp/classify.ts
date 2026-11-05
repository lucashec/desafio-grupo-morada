export type ErpTransportError = 'ECONNREFUSED' | 'ECONNRESET' | 'TIMEOUT';

export type RawErpResponse = { status: number } | { errorCode: ErpTransportError };

export type CreateClassification =
  | { kind: 'SUCCESS' }
  | { kind: 'TRANSIENT_ERROR' }
  | { kind: 'PERMANENT_ERROR' }
  | { kind: 'AMBIGUOUS'; cause: 'TIMEOUT' | 'CONFLICT' };

export type LookupClassification = 'FOUND' | 'NOT_FOUND' | 'UNKNOWN';

export function classifyCreate(raw: RawErpResponse): CreateClassification {
  if ('errorCode' in raw) {
    return raw.errorCode === 'TIMEOUT' ? { kind: 'AMBIGUOUS', cause: 'TIMEOUT' } : { kind: 'TRANSIENT_ERROR' };
  }
  const { status } = raw;
  if (status >= 200 && status < 300) return { kind: 'SUCCESS' };
  if (status === 409) return { kind: 'AMBIGUOUS', cause: 'CONFLICT' };
  if (status === 408 || status === 429 || status >= 500) return { kind: 'TRANSIENT_ERROR' };
  if (status >= 400) return { kind: 'PERMANENT_ERROR' };
  return { kind: 'TRANSIENT_ERROR' };
}

export function classifyLookup(raw: RawErpResponse): LookupClassification {
  if ('errorCode' in raw) return 'UNKNOWN';
  if (raw.status >= 200 && raw.status < 300) return 'FOUND';
  if (raw.status === 404) return 'NOT_FOUND';
  return 'UNKNOWN';
}
