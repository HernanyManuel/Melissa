-- Run manually, only in a disposable *test* database after migration 66.
-- Requires psql -v reconciler_password=<independent-secret>.
-- Changing a NOLOGIN role to LOGIN is an explicit operator choice and must
-- never be part of a production automatic deploy.
ALTER ROLE melissa_billing_reconciler PASSWORD :'reconciler_password';
ALTER ROLE melissa_billing_reconciler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
