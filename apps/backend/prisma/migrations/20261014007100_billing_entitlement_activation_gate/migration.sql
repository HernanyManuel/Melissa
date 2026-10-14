BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ADR-113: separate commercial entitlement authority from provider status,
-- public plan limits, Stripe redirect, and observed resource counts.
-- This global hard stop CANNOT be enabled by an UPDATE, even as database owner.
CREATE TABLE billing_entitlement_activation_gate (
  key VARCHAR(40) PRIMARY KEY CHECK (key='paid_automation'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK (enabled=FALSE),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version=1)
);
INSERT INTO billing_entitlement_activation_gate(key,enabled,policy_version)
VALUES('paid_automation',FALSE,1);
ALTER TABLE billing_entitlement_activation_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_entitlement_activation_gate FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_entitlement_gate_read ON billing_entitlement_activation_gate
  FOR SELECT TO melissa_runtime USING (enabled=FALSE);
GRANT SELECT(key,enabled,policy_version)
  ON billing_entitlement_activation_gate TO melissa_runtime;

-- No INSERT, UPDATE, DELETE or TRUNCATE grants. Future activation requires
-- a reviewed migration replacing this hard CHECK and explicit policy decision.
UPDATE infrastructure_metadata SET value='71' WHERE key='schema_version';
COMMIT;
