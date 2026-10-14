BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ADR-114: technical AI token observations, NEVER billable conversations
-- or a payment/settlement ledger. Exact-once derives from the existing
-- (tenant_id, turn_id) uniqueness on ai_usage_events.
CREATE TABLE billing_usage_observations (
  tenant_id UUID NOT NULL,
  source_event_id UUID NOT NULL,
  turn_id UUID NOT NULL,
  source_outcome VARCHAR(24) NOT NULL
    CHECK (source_outcome IN ('completed','handoff_required','failed','stale')),
  input_tokens INTEGER NOT NULL CHECK (input_tokens BETWEEN 0 AND 100000000),
  output_tokens INTEGER NOT NULL CHECK (output_tokens BETWEEN 0 AND 100000000),
  observed_at TIMESTAMPTZ(6) NOT NULL,
  ingested_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  billable BOOLEAN NOT NULL DEFAULT FALSE CHECK (billable=FALSE),
  PRIMARY KEY (tenant_id,source_event_id),
  UNIQUE (tenant_id,turn_id),
  FOREIGN KEY (tenant_id,source_event_id)
    REFERENCES ai_usage_events(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,turn_id)
    REFERENCES ai_turns(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX billing_usage_observations_tenant_time_idx
  ON billing_usage_observations(tenant_id,observed_at,source_event_id);

ALTER TABLE billing_usage_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_usage_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_usage_tenant_read ON billing_usage_observations
  FOR SELECT TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT (tenant_id,source_event_id,turn_id,source_outcome,input_tokens,
              output_tokens,observed_at,billable)
  ON billing_usage_observations TO melissa_runtime;

-- Every inserted AI usage event is recorded within its existing transaction.
-- Failure to insert the observation rolls back the source event too.
-- Fixed schema, no caller-provided financial amount, price, or billing period.
CREATE FUNCTION public.capture_ai_usage_observation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $func$
BEGIN
  INSERT INTO public.billing_usage_observations (
    tenant_id,source_event_id,turn_id,source_outcome,
    input_tokens,output_tokens,observed_at,billable
  ) VALUES (
    NEW.tenant_id,NEW.id,NEW.turn_id,NEW.outcome,
    NEW.input_tokens,NEW.output_tokens,NEW.created_at,FALSE
  );
  RETURN NEW;
END
$func$;
REVOKE ALL ON FUNCTION public.capture_ai_usage_observation() FROM PUBLIC;
CREATE TRIGGER capture_billing_ai_usage
  AFTER INSERT ON ai_usage_events
  FOR EACH ROW EXECUTE FUNCTION public.capture_ai_usage_observation();

-- Also capture already committed usage, without treating it as billable.
INSERT INTO billing_usage_observations (
  tenant_id,source_event_id,turn_id,source_outcome,
  input_tokens,output_tokens,observed_at,billable
)
SELECT tenant_id,id,turn_id,outcome,input_tokens,output_tokens,created_at,FALSE
FROM ai_usage_events;

-- A verified append-only journal. Even a privileged direct UPDATE or DELETE
-- is rejected until a reviewed migration explicitly replaces this trigger.
CREATE FUNCTION public.prevent_billing_usage_mutation()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $func$
BEGIN
  RAISE EXCEPTION 'billing usage observations are append-only';
END
$func$;
REVOKE ALL ON FUNCTION public.prevent_billing_usage_mutation() FROM PUBLIC;
CREATE TRIGGER billing_usage_immutable
  BEFORE UPDATE OR DELETE ON billing_usage_observations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_billing_usage_mutation();

-- No runtime INSERT, UPDATE or DELETE; the same tenant-scoped access
-- discipline as other diagnostic billing reads remains in force.
UPDATE infrastructure_metadata SET value='72' WHERE key='schema_version';
COMMIT;
