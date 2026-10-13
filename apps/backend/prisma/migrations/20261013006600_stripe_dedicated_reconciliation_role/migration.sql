BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The dedicated role is provisioned as NOLOGIN before migrations.
-- Login credentials are provisioned independently *only* for controlled
-- test reconciliation. API/worker remains melissa_runtime, unchanged.
GRANT USAGE ON SCHEMA public TO melissa_billing_reconciler;

-- Stripe event payload is sensitive; only this dedicated consumer gets
-- READ access. Never grant mutation or event insertion permissions.
CREATE POLICY stripe_events_reconciler_read ON stripe_webhook_events
  FOR SELECT TO melissa_billing_reconciler USING (livemode=FALSE);
GRANT SELECT ON stripe_webhook_events TO melissa_billing_reconciler;

-- Pre-linked subscriptions across tenants must be discoverable by the
-- globally unique Stripe provider ID. Binding columns cannot be mutated.
CREATE POLICY subscriptions_reconciler_select ON subscriptions
  FOR SELECT TO melissa_billing_reconciler USING (provider='stripe');
CREATE POLICY subscriptions_reconciler_update ON subscriptions
  FOR UPDATE TO melissa_billing_reconciler
  USING (provider='stripe') WITH CHECK (provider='stripe');
GRANT SELECT ON subscriptions TO melissa_billing_reconciler;
GRANT UPDATE (
  status,current_period_start,current_period_end,cancel_at_period_end,
  trial_end,updated_at
) ON subscriptions TO melissa_billing_reconciler;

-- Price identity only: no global catalog mutation/financial price data.
GRANT SELECT (id,stripe_price_id) ON plans TO melissa_billing_reconciler;

-- Insert-only audit with readback (Prisma INSERT ... RETURNING).
-- No DELETE/UPDATE of audit history and no role grants on tenants/customers.
CREATE POLICY stripe_attempts_reconciler_read ON stripe_reconciliation_attempts
  FOR SELECT TO melissa_billing_reconciler USING (TRUE);
CREATE POLICY stripe_attempts_reconciler_insert ON stripe_reconciliation_attempts
  FOR INSERT TO melissa_billing_reconciler WITH CHECK (TRUE);
GRANT SELECT ON stripe_reconciliation_attempts TO melissa_billing_reconciler;
GRANT INSERT (id,event_id,outcome,reason,tenant_id)
  ON stripe_reconciliation_attempts TO melissa_billing_reconciler;

UPDATE infrastructure_metadata SET value='66' WHERE key='schema_version';
COMMIT;
