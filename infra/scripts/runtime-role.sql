-- Run as database administrator before migrations. Password passed by psql variable.
SELECT 'CREATE ROLE melissa_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='melissa_runtime')\gexec
ALTER ROLE melissa_runtime PASSWORD :'runtime_password';
ALTER ROLE melissa_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

-- Provision without LOGIN. A separate, explicitly executed test-only step
-- sets an independent password. Never reuse runtime or migration credentials.
SELECT 'CREATE ROLE melissa_billing_reconciler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='melissa_billing_reconciler')\gexec
ALTER ROLE melissa_billing_reconciler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
