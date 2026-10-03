BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE bookings
  ADD COLUMN idempotency_key VARCHAR(200),
  ADD COLUMN turn_id UUID,
  ADD COLUMN arguments_hash CHAR(64),
  ADD COLUMN timezone VARCHAR(80),
  ADD COLUMN duration_minutes INTEGER,
  ADD COLUMN price_snapshot NUMERIC(20,6),
  ADD COLUMN currency_snapshot VARCHAR(3),
  ADD CONSTRAINT bookings_turn_fkey FOREIGN KEY (tenant_id, turn_id)
    REFERENCES ai_turns(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT bookings_arguments_hash_check CHECK (
    arguments_hash IS NULL OR arguments_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT bookings_duration_snapshot_check CHECK (
    duration_minutes IS NULL OR duration_minutes > 0
  ),
  ADD CONSTRAINT bookings_price_snapshot_check CHECK (
    price_snapshot IS NULL OR price_snapshot >= 0
  ),
  ADD CONSTRAINT bookings_currency_snapshot_check CHECK (
    currency_snapshot IS NULL OR currency_snapshot ~ '^[A-Z]{3}$'
  ),
  ADD CONSTRAINT bookings_ai_scope_check CHECK (
    source <> 'ai' OR (
      conversation_id IS NOT NULL AND turn_id IS NOT NULL AND idempotency_key IS NOT NULL AND
      arguments_hash IS NOT NULL AND timezone IS NOT NULL AND duration_minutes IS NOT NULL AND
      price_snapshot IS NOT NULL AND currency_snapshot IS NOT NULL
    )
  );

CREATE UNIQUE INDEX bookings_ai_idempotency_key
  ON bookings(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE booking_outbox (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_outbox_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT booking_outbox_id_key UNIQUE (id),
  CONSTRAINT booking_outbox_booking_fkey FOREIGN KEY (tenant_id, booking_id)
    REFERENCES bookings(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_outbox_event_check CHECK (event_type IN ('created', 'cancelled', 'rescheduled')),
  CONSTRAINT booking_outbox_state_check CHECK (state IN ('pending', 'processed', 'failed')),
  CONSTRAINT booking_outbox_attempts_check CHECK (attempts BETWEEN 0 AND 100),
  CONSTRAINT booking_outbox_booking_event_key UNIQUE (tenant_id, booking_id, event_type)
);

CREATE INDEX booking_outbox_pending_idx
  ON booking_outbox(state, next_attempt_at, id)
  WHERE state='pending';
CREATE INDEX booking_outbox_tenant_idx
  ON booking_outbox(tenant_id, created_at, id);

ALTER TABLE booking_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_outbox_tenant_scope ON booking_outbox TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON booking_outbox TO melissa_runtime;

UPDATE infrastructure_metadata SET value='30' WHERE key='schema_version';
COMMIT;
