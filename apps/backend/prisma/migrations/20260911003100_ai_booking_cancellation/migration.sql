BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE bookings
  ADD COLUMN cancelled_at TIMESTAMPTZ(6),
  ADD COLUMN cancellation_reason VARCHAR(500);

UPDATE bookings
SET cancelled_at=COALESCE(updated_at, created_at)
WHERE status='cancelled' AND cancelled_at IS NULL;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_cancellation_state_check CHECK (
    (status='cancelled' AND cancelled_at IS NOT NULL) OR
    (status<>'cancelled' AND cancelled_at IS NULL AND cancellation_reason IS NULL)
  );

CREATE TABLE booking_operations (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  turn_id UUID NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  operation VARCHAR(24) NOT NULL,
  arguments_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_operations_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT booking_operations_id_key UNIQUE (id),
  CONSTRAINT booking_operations_booking_fkey FOREIGN KEY (tenant_id, booking_id)
    REFERENCES bookings(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_operations_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_operations_customer_fkey FOREIGN KEY (tenant_id, customer_id)
    REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_operations_turn_fkey FOREIGN KEY (tenant_id, turn_id)
    REFERENCES ai_turns(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_operations_operation_check CHECK (operation IN ('cancel', 'reschedule')),
  CONSTRAINT booking_operations_arguments_hash_check CHECK (arguments_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT booking_operations_idempotency_key UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX booking_operations_booking_idx
  ON booking_operations(tenant_id, booking_id, created_at, id);

ALTER TABLE booking_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_operations_tenant_scope ON booking_operations TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON booking_operations TO melissa_runtime;

UPDATE infrastructure_metadata SET value='31' WHERE key='schema_version';
COMMIT;
