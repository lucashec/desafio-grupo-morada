import { z } from 'zod';

export const ORDER_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SENT',
  'RETRY_SCHEDULED',
  'FAILED',
  'UNCERTAIN',
  'NEEDS_REVIEW',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orderPayloadSchema = z.strictObject({
  customer: z.strictObject({
    name: z.string().trim().min(1).max(120),
    document: z.string().regex(/^(\d{11}|\d{14})$/, 'must be 11 or 14 digits'),
    email: z.email().max(254),
  }),
  items: z
    .array(
      z.strictObject({
        sku: z.string().trim().min(1).max(64),
        quantity: z.number().int().min(1).max(10_000),
        unitPriceCents: z.number().int().min(0).max(100_000_000),
      }),
    )
    .min(1)
    .max(100),
  notes: z.string().max(500).optional(),
});
export type OrderPayload = z.infer<typeof orderPayloadSchema>;

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
