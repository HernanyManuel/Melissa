#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v runtime_password="$RUNTIME_PASSWORD" <<'SQL'
CREATE ROLE melissa_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'runtime_password';
SQL
