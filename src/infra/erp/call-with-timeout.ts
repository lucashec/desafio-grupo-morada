import type { OrderPayload } from '../../domain/order.js';
import { erpError, type CreateOrderResult, type ErpClient, type LookupResult } from './erp-client.js';

export async function callWithTimeout<T>(fn: () => Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function withTimeouts(client: ErpClient, opts: { createMs: number; lookupMs: number }): ErpClient {
  return {
    createOrder: (reference: string, payload: OrderPayload) =>
      callWithTimeout<CreateOrderResult>(
        () => client.createOrder(reference, payload),
        opts.createMs,
        () => ({ kind: 'AMBIGUOUS', cause: 'TIMEOUT' }),
      ),
    lookupByReference: (reference: string) =>
      callWithTimeout<LookupResult>(
        () => client.lookupByReference(reference),
        opts.lookupMs,
        () => ({ kind: 'UNKNOWN', ...erpError('ERP_LOOKUP_TIMEOUT', 'ERP lookup timed out') }),
      ),
  };
}
