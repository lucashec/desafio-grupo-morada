import type { OrderPayload } from '../../domain/order.js';

export const ERP_ERROR_CODE_MAX = 64;
export const ERP_ERROR_MESSAGE_MAX = 200;

export type ErpError = { code: string; message: string };

export type CreateOrderResult =
  | { kind: 'SUCCESS'; erpOrderId: string }
  | ({ kind: 'TRANSIENT_ERROR' } & ErpError)
  | ({ kind: 'PERMANENT_ERROR' } & ErpError)
  | { kind: 'AMBIGUOUS'; cause: 'TIMEOUT' | 'CONFLICT' };

export type LookupResult =
  | { kind: 'FOUND'; erpOrderId: string }
  | { kind: 'NOT_FOUND' }
  | ({ kind: 'UNKNOWN' } & ErpError);

export interface ErpClient {
  createOrder(reference: string, payload: OrderPayload): Promise<CreateOrderResult>;
  lookupByReference(reference: string): Promise<LookupResult>;
}

export function erpError(code: string, message: string): ErpError {
  return { code: code.slice(0, ERP_ERROR_CODE_MAX), message: message.slice(0, ERP_ERROR_MESSAGE_MAX) };
}
