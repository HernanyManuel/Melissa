BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Phase 9: immutable commercial contract shape; no published prices or
-- subscription activation path. Privileged migrations/provider reconciliation
-- will be the only writers until signed Stripe event handling is built.
CREATE TABLE plans (
  id UUID PRIMARY KEY,
  key VARCHAR(64) NOT NULL UNIQUE CHECK (length(btrim(key)) > 0),
  name VARCHAR(120) NOT NULL CHECK (length(btrim(name)) > 0),
  currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  base_price NUMERIC(20,6) NOT NULL CHECK (base_price >= 0),
  billing_interval VARCHAR(16) NOT NULL CHECK (billing_interval IN ('month','year')),
  included_conversations INTEGER NOT NULL CHECK (included_conversations >= 0),
  included_messages INTEGER CHECK (included_messages IS NULL OR included_messages >= 0),
  included_staff INTEGER NOT NULL CHECK (included_staff >= 0),
  included_channels INTEGER NOT NULL CHECK (included_channels >= 0),
  included_locations INTEGER NOT NULL CHECK (included_locations >= 0),
  overage_price_per_conversation NUMERIC(20,6) NOT NULL
    CHECK (overage_price_per_conversation >= 0),
  features JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features)='object'),
  stripe_product_id VARCHAR(255),
  stripe_price_id VARCHAR(255),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX plans_stripe_price_unique ON plans(stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;

CREATE TABLE subscriptions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  provider VARCHAR(16) NOT NULL CHECK (provider='stripe'),
  provider_customer_id VARCHAR(255) NOT NULL CHECK (length(btrim(provider_customer_id)) > 0),
  provider_subscription_id VARCHAR(255) NOT NULL CHECK (length(btrim(provider_subscription_id)) > 0),
  status VARCHAR(32) NOT NULL CHECK (status IN (
    'incomplete','incomplete_expired','trialing','active','past_due',
    'canceled','unpaid','paused'
  )),
  current_period_start TIMESTAMPTZ(6) NOT NULL,
  current_period_end TIMESTAMPTZ(6) NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  trial_end TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id),
  UNIQUE (provider, provider_subscription_id),
  CHECK (current_period_end > current_period_start)
);
CREATE INDEX subscriptions_plan_idx ON subscriptions(plan_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant_read ON subscriptions TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Global plan catalog has no tenant contents. Runtime receives only public
-- fields, not Stripe provider mappings or mutation privileges.
GRANT SELECT (id,key,name,currency,base_price,billing_interval,
  included_conversations,included_messages,included_staff,included_channels,
  included_locations,overage_price_per_conversation,features,active)
  ON plans TO melissa_runtime;
GRANT SELECT (tenant_id,id,plan_id,provider,status,current_period_start,
  current_period_end,cancel_at_period_end,trial_end)
  ON subscriptions TO melissa_runtime;

UPDATE infrastructure_metadata SET value='63' WHERE key='schema_version';
COMMIT;
