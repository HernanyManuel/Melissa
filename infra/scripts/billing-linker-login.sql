-- Opt-in for a disposable Stripe TEST database only. Provision an unrelated,
-- strong password with psql -v linker_password=..., never in source control.
-- The role is NOLOGIN by default; never activate it in production.
ALTER ROLE melissa_billing_linker PASSWORD :'linker_password';
ALTER ROLE melissa_billing_linker
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
