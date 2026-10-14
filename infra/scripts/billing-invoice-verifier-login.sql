-- Deliberate test-mode login provisioning for an otherwise NOLOGIN role.
-- Use psql -v invoice_verifier_password=<independent-secret> in test only.
ALTER ROLE melissa_billing_invoice_verifier PASSWORD :'invoice_verifier_password';
ALTER ROLE melissa_billing_invoice_verifier
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
