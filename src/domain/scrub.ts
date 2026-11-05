import { ERP_ERROR_MESSAGE_MAX } from '../infra/erp/erp-client.js';

export const MIN_NAME_LENGTH = 4;
const MIN_TAIL_LENGTH = 4;
const REDACTED = '[REDACTED]';

type Customer = { document: string; email: string; name: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digitsPattern = (digits: string) => digits.split('').join('[.\\-/\\s]?');

function patterns(c: Customer): Array<{ length: number; source: (n?: number) => string }> {
  const list = [
    { value: c.document.replace(/\D/g, ''), source: (v: string) => digitsPattern(v) },
    { value: c.email, source: escape },
    ...(c.name.trim().length >= MIN_NAME_LENGTH ? [{ value: c.name.trim(), source: escape }] : []),
  ].filter((p) => p.value.length > 0);
  return list
    .map((p) => ({ length: p.value.length, source: (n = p.value.length) => p.source(p.value.slice(0, n)) }))
    .sort((a, b) => b.length - a.length);
}

export function scrubErpMessage(message: string, customer: Customer): string {
  let out = message;
  const ps = patterns(customer);
  for (const p of ps) out = out.replace(new RegExp(p.source(), 'gi'), REDACTED);
  for (const p of ps) {
    for (let n = p.length - 1; n >= MIN_TAIL_LENGTH; n--) {
      const tail = new RegExp(`${p.source(n)}$`, 'i');
      if (tail.test(out)) {
        out = out.replace(tail, REDACTED);
        break;
      }
    }
  }
  return out;
}

export function safeErpMessage(message: string, customer: Customer): string {
  return scrubErpMessage(message, customer).slice(0, ERP_ERROR_MESSAGE_MAX);
}
