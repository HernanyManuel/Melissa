BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE ai_model_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key VARCHAR(64) NOT NULL,
  model_key VARCHAR(128) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  input_price_micros_per_million BIGINT NOT NULL,
  output_price_micros_per_million BIGINT NOT NULL,
  effective_from TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT ai_model_prices_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ai_model_prices_input_price_check CHECK (input_price_micros_per_million >= 0),
  CONSTRAINT ai_model_prices_output_price_check CHECK (output_price_micros_per_million >= 0),
  CONSTRAINT ai_model_prices_identity_key UNIQUE (provider_key, model_key, effective_from)
);

CREATE INDEX ai_model_prices_lookup_idx
  ON ai_model_prices (provider_key, model_key, effective_from DESC);

ALTER TABLE ai_usage_events
  ADD COLUMN pricing_id UUID,
  ADD COLUMN currency VARCHAR(3),
  ADD COLUMN input_price_micros_per_million BIGINT,
  ADD COLUMN output_price_micros_per_million BIGINT,
  ADD COLUMN cost_micros BIGINT,
  ADD CONSTRAINT ai_usage_events_pricing_snapshot_check CHECK (
    (pricing_id IS NULL AND currency IS NULL
      AND input_price_micros_per_million IS NULL
      AND output_price_micros_per_million IS NULL
      AND cost_micros IS NULL)
    OR
    (pricing_id IS NOT NULL AND currency ~ '^[A-Z]{3}$'
      AND input_price_micros_per_million >= 0
      AND output_price_micros_per_million >= 0
      AND cost_micros >= 0)
  );

GRANT SELECT ON ai_model_prices TO melissa_runtime;
GRANT INSERT (
  tenant_id, id, turn_id, provider_key, model_key, input_tokens, output_tokens, outcome,
  pricing_id, currency, input_price_micros_per_million, output_price_micros_per_million, cost_micros
) ON ai_usage_events TO melissa_runtime;

UPDATE infrastructure_metadata SET value='47' WHERE key='schema_version';
COMMIT;
