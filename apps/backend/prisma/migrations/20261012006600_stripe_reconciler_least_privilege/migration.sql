BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Required pre-provisioned, non-owner login role. No BYPASSRLS or superuser.
-- Migration intentionally fails if this role is missing; do not silently
-- fall back to a migration account for provider reconciliation.
GRANT USAGE ON SCHEMA public TO melissa_stripe_reconciler;

-- Test event bodies contain PII and never flow through melissa_runtime
-- queries. Only the dedicated offline reconciliation role may read them.
CREATE POLICY stripe_test_reconciler_read ON stripe_webhook_events
  FOR SELECT TO melissa_stripe_reconciler USING (livemode=FALSE);
GRANT SELECT ON stripe_webhook_events TO melissa_stripe_reconciler;

-- Global catalog read is needed to check Stripe price consistency.
GRANT SELECT ON plans TO melissa_stripe_reconciler;

-- This role can reconcile ONLY already-bound Stripe subscriptions. It
-- cannot update tenant, local id, plan, provider, provider customer or
-- provider subscription identifiers; no INSERT or DELETE privileges.
CREATE POLICY stripe_test_reconciler_subscriptions_read ON subscriptions
  FOR SELECT TO melissa_stripe_reconciler USING (provider='stripe');
CREATE POLICY stripe_test_reconciler_subscriptions_update ON subscriptions
  FOR UPDATE TO melissa_stripe_reconciler
  USING (provider='stripe') WITH CHECK (provider='stripe');
GRANT SELECT ON subscriptions TO melissa_stripe_reconciler;
GRANT UPDATE (status,current_period_start,current_period_end,
  cancel_at_period_end,trial_end,updated_at)
  ON subscriptions TO melissa_stripe_reconciler;

-- Append-only outcome log: no UPDATE, DELETE or INSERT of event evidence.
CREATE POLICY stripe_test_reconciler_audit_read ON stripe_reconciliation_attempts
  FOR SELECT TO melissa_stripe_reconciler USING (TRUE);
CREATE POLICY stripe_test_reconciler_audit_insert ON stripe_reconciliation_attempts
  FOR INSERT TO melissa_stripe_reconciler WITH CHECK (TRUE);
GRANT SELECT ON stripe_reconciliation_attempts TO melissa_stripe_reconciler;
GRANT INSERT (id,event_id,outcome,reason,tenant_id)
  ON stripe_reconciliation_attempts TO melissa_stripe_reconciler;

UPDATE infrastructure_metadata SET value='66' WHERE key='schema_version';
COMMIT;
