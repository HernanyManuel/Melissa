-- Execute as database administrator BEFORE migration 66. Pass the
-- password via psql -v stripe_reconcile_password=... from a secret store.
-- The role is intentionally separate from both melissa_runtime and
-- the highly privileged migration connection.
SELECT 'CREATE ROLE melissa_stripe_reconciler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='melissa_stripe_reconciler')\gexec
ALTER ROLE melissa_stripe_reconciler PASSWORD :'stripe_reconcile_password';
ALTER ROLE melissa_stripe_reconciler NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
