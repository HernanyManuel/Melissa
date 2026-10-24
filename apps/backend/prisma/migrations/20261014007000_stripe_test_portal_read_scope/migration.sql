BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- ADR-112: tenant RLS SELECT scope only, needed for a verified, tenant-bound
-- read-only Stripe TEST billing Portal launch. No subscription mutation.
-- The runtime can see provider IDs only while app.tenant_id is set under
-- TenantService.scoped and a billing:write actor is authorized by Nest.
GRANT SELECT (provider_customer_id,provider_subscription_id,checkout_session_id)
  ON subscriptions TO melissa_runtime;

-- Retain existing FORCE RLS; prove grants did not add mutations.
UPDATE infrastructure_metadata SET value='70' WHERE key='schema_version';
COMMIT;
