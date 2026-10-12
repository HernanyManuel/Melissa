BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Auditable test-mode reconciler decisions. Provider payload is *not*
-- duplicated here, and an event cannot invent the trusted tenant binding.
CREATE TABLE stripe_reconciliation_attempts (
  id UUID PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL
    REFERENCES stripe_webhook_events(event_id) ON DELETE RESTRICT,
  outcome VARCHAR(20) NOT NULL
    CHECK (outcome IN ('applied','unmapped','rejected','deferred','skipped')),
  reason VARCHAR(40) NOT NULL
    CHECK (reason IN (
      'provider_current','no_known_subscription','unsupported_event',
      'event_not_reconcilable','provider_unavailable','provider_mismatch',
      'price_mismatch','invalid_provider_snapshot','live_mode_forbidden'
    )),
  tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((outcome='applied' AND tenant_id IS NOT NULL) OR outcome <> 'applied')
);
CREATE INDEX stripe_reconciliation_attempts_event_idx
  ON stripe_reconciliation_attempts(event_id, created_at);
ALTER TABLE stripe_reconciliation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_reconciliation_attempts FORCE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE grants or runtime RLS policy: only a
-- separately invoked privileged reconciliation command can record attempts.
-- Existing payment/entitlement grants remain unchanged.
UPDATE infrastructure_metadata SET value='65' WHERE key='schema_version';
COMMIT;
