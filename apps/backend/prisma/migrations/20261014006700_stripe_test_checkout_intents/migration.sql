BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ADR-109: tenant-bound, short-lived Stripe test Checkout requests.
-- These are NOT subscriptions or paid entitlements. Checkout completion
-- must be independently authenticated and matched before any future binding.
CREATE TABLE stripe_checkout_intents (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  stripe_price_id VARCHAR(255) NOT NULL CHECK (stripe_price_id ~ '^price_[a-zA-Z0-9_-]+$'),
  request_id UUID NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','expired')),
  checkout_session_id VARCHAR(255) UNIQUE,
  checkout_url TEXT,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, request_id),
  CHECK ((status <> 'ready') OR (checkout_session_id IS NOT NULL AND checkout_url IS NOT NULL)),
  CHECK ((checkout_session_id IS NULL) = (checkout_url IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX stripe_checkout_one_open_per_tenant
  ON stripe_checkout_intents(tenant_id) WHERE status IN ('pending','ready');
CREATE INDEX stripe_checkout_expiration ON stripe_checkout_intents(status,expires_at);

ALTER TABLE stripe_checkout_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_checkout_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY checkout_tenant_select ON stripe_checkout_intents
  FOR SELECT TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY checkout_tenant_insert ON stripe_checkout_intents
  FOR INSERT TO melissa_runtime
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY checkout_tenant_update ON stripe_checkout_intents
  FOR UPDATE TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- Stripe product/price identities may be selected by the trusted server
-- for checkout validation but are never serialized to an HTTP client.
GRANT SELECT (stripe_product_id, stripe_price_id) ON plans TO melissa_runtime;
GRANT SELECT ON stripe_checkout_intents TO melissa_runtime;
GRANT INSERT (id,tenant_id,plan_id,stripe_price_id,request_id,status,
              expires_at,created_at,updated_at)
  ON stripe_checkout_intents TO melissa_runtime;
GRANT UPDATE (status,checkout_session_id,checkout_url,updated_at)
  ON stripe_checkout_intents TO melissa_runtime;
-- There is deliberately NO INSERT/UPDATE/DELETE on subscriptions,
-- and no access to checkout intents for the billing reconciler.
UPDATE infrastructure_metadata SET value='67' WHERE key='schema_version';
COMMIT;
