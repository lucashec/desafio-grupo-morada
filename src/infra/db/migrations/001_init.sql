CREATE TABLE orders (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key    text        NOT NULL,
  request_hash       char(64)    NOT NULL,
  payload            jsonb       NOT NULL,
  status             text        NOT NULL DEFAULT 'PENDING',
  attempts           integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    timestamptz          DEFAULT now(),
  locked_until       timestamptz,
  lease_token        uuid,
  erp_order_id       text,
  last_error_code    varchar(64),
  last_error_message varchar(200),
  correlation_id     varchar(64) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- REQ-IDEM-01: uniqueness is enforced by the database, never by the application.
  CONSTRAINT orders_idempotency_key_uq UNIQUE (idempotency_key),
  CONSTRAINT orders_status_ck CHECK (status IN (
    'PENDING', 'PROCESSING', 'SENT', 'RETRY_SCHEDULED', 'FAILED', 'UNCERTAIN', 'NEEDS_REVIEW')),
  -- Second line of defense: a PROCESSING order always carries a lease, and only then.
  CONSTRAINT orders_processing_has_lease_ck CHECK (
    (status = 'PROCESSING') = (lease_token IS NOT NULL AND locked_until IS NOT NULL)),
  CONSTRAINT orders_sent_has_erp_id_ck CHECK (status <> 'SENT' OR erp_order_id IS NOT NULL)
);

-- Worker claim of due orders. Partial: terminal orders (most rows over time) are not indexed.
CREATE INDEX orders_due_idx ON orders (next_attempt_at)
  WHERE status IN ('PENDING', 'RETRY_SCHEDULED', 'UNCERTAIN');

-- Recovery of expired leases (crashed worker). Tiny: only in-flight orders.
CREATE INDEX orders_lease_idx ON orders (locked_until) WHERE status = 'PROCESSING';

-- Append-only audit trail: one row per fact (creation, claim, ERP call, reprocess).
CREATE TABLE order_events (
  id             bigserial   PRIMARY KEY,
  order_id       uuid        NOT NULL REFERENCES orders (id),
  type           text        NOT NULL CHECK (type IN (
                   'CREATED', 'ATTEMPT_STARTED', 'ERP_CREATE', 'ERP_LOOKUP',
                   'ATTEMPT_ABANDONED', 'REPROCESS_REQUESTED')),
  from_status    text,
  to_status      text,        -- NULL = transition not applied (lease lost)
  attempt        integer,
  outcome        text,
  error_code     varchar(64),
  error_message  varchar(200),
  duration_ms    integer,
  reason         varchar(200),
  lease_token    uuid,
  correlation_id varchar(64) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX order_events_order_idx ON order_events (order_id, id);
