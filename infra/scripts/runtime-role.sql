-- Run as database administrator before migrations. Password passed by psql variable.
SELECT 'CREATE ROLE melissa_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='melissa_runtime')\gexec
ALTER ROLE melissa_runtime PASSWORD :'runtime_password';
ALTER ROLE melissa_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
