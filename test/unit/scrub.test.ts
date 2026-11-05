import { describe, expect, it } from 'vitest';
import { scrubErpMessage, safeErpMessage, MIN_NAME_LENGTH } from '../../src/domain/scrub.js';

const customer = { document: '98765432100', email: 'zelda.marker@example.test', name: 'Zelda Marcadora' };

describe('ERP message scrubbing (defence in depth)', () => {
  // REQ-OBS-04
  it.each([
    ['digits only', 'rejected document 98765432100 for customer'],
    ['CPF formatted', 'rejected document 987.654.321-00 for customer'],
    ['spaces and slash', 'doc 987 654 321/00 invalid'],
  ])('redacts the document (%s)', (_label, message) => {
    const out = scrubErpMessage(message, customer);
    expect(out.replace(/\D/g, '')).not.toContain('98765432100');
    expect(out).toContain('[REDACTED]');
  });

  // REQ-OBS-04
  it('redacts email and name regardless of case', () => {
    const out = scrubErpMessage('user ZELDA.MARKER@EXAMPLE.TEST (zelda marcadora) is blocked', customer);
    expect(out.toLowerCase()).not.toContain('zelda');
    expect(out).toBe('user [REDACTED] ([REDACTED]) is blocked');
  });

  // REQ-OBS-04
  it(`does not redact names shorter than ${MIN_NAME_LENGTH} characters (accepted risk P-08)`, () => {
    const out = scrubErpMessage('Ana rejected by Ana rules', { ...customer, name: 'Ana' });
    expect(out).toBe('Ana rejected by Ana rules');
  });

  // REQ-OBS-04
  it('replaces longer values first so a contained value leaves nothing behind', () => {
    const c = { document: '12345678901', email: 'zelda marcadora@x.test', name: 'Zelda Marcadora' };
    expect(scrubErpMessage('bad zelda marcadora@x.test', c)).toBe('bad [REDACTED]');
  });

  // REQ-OBS-04
  it('a document crossing position 200 leaves no prefix of 4+ digits after truncation', () => {
    const message = `${'x'.repeat(195)}98765432100 tail`;
    const out = safeErpMessage(message.slice(0, 200), customer);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/9876/);
    const full = safeErpMessage(message, customer);
    expect(full.length).toBeLessThanOrEqual(200);
    expect(full).not.toMatch(/9876/);
  });

  // REQ-OBS-04
  it('a trailing partial email or name is redacted too', () => {
    expect(safeErpMessage('blocked: zelda.mar', customer)).toBe('blocked: [REDACTED]');
    expect(safeErpMessage('blocked: Zelda Mar', customer)).toBe('blocked: [REDACTED]');
  });

  // REQ-OBS-04
  it('keeps unrelated text intact and bounds the result to 200 characters', () => {
    expect(safeErpMessage('ERP unavailable', customer)).toBe('ERP unavailable');
    expect(safeErpMessage('y'.repeat(1000), customer)).toHaveLength(200);
  });
});
