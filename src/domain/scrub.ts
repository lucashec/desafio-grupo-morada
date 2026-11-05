import { ERP_ERROR_MESSAGE_MAX } from '../infra/erp/erp-client.js';

/** Shorter names would match ordinary words; not redacted (accepted risk P-08). */
export const MIN_NAME_LENGTH = 4;
/** A trailing fragment this long of a sensitive value (cut by truncation) is redacted too. */
const MIN_TAIL_LENGTH = 4;
const REDACTED = '[REDACTED]';

type Customer = { document: string; email: string; name: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Digits optionally separated by . - / or space: matches 98765432100 and 987.654.321-00. */
const digitsPattern = (digits: string) => digits.split('').join('[.\\-/\\s]?');

function patterns(c: Customer): Array<{ length: number; source: (n?: number) => string }> {
  const list = [
    { value: c.document.replace(/\D/g, ''), source: (v: string) => digitsPattern(v) },
    { value: c.email, source: escape },
    ...(c.name.trim().length >= MIN_NAME_LENGTH ? [{ value: c.name.trim(), source: escape }] : []),
  ].filter((p) => p.value.length > 0);
  return list
    .map((p) => ({ length: p.value.length, source: (n = p.value.length) => p.source(p.value.slice(0, n)) }))
    .sort((a, b) => b.length - a.length); // longer values first: a contained value leaves nothing behind
}

/**
 * REQ-OBS-04: replaces the order's own personal data echoed by the ERP. Defence in
 * depth, not a guarantee: transformed echoes (abbreviated, masked, encoded) pass.
 */
export function scrubErpMessage(message: string, customer: Customer): string {
  let out = message;
  const ps = patterns(customer);
  for (const p of ps) out = out.replace(new RegExp(p.source(), 'gi'), REDACTED);
  // A value cut at the end of the text (by an earlier truncation) still leaks its prefix.
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

/** Scrub first, then bound: a value crossing the limit can never survive half-cut. */
export function safeErpMessage(message: string, customer: Customer): string {
  return scrubErpMessage(message, customer).slice(0, ERP_ERROR_MESSAGE_MAX);
}
