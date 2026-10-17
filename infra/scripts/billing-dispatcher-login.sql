-- Deliberate, test-only provisioning after schema 69 migration.
-- Execute with psql -v dispatcher_password=<independent-secret>.
-- NOLOGIN is the default: never enable this role automatically in production.
ALTER ROLE melissa_billing_dispatcher PASSWORD :'dispatcher_password';
ALTER ROLE melissa_billing_dispatcher
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
