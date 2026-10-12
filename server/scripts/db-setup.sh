#!/usr/bin/env bash
# One-time local setup: creates the database and the two login roles.
#   giddy_owner — owns all tables, runs migrations. Never used to serve requests.
#   giddy_app   — used by the API. NOBYPASSRLS, so every query is filtered by row-level security.
# Run as a PostgreSQL superuser, e.g.:  sudo -u postgres bash server/scripts/db-setup.sh
set -euo pipefail
DB_NAME="${DB_NAME:-giddy}"
OWNER_PW="${OWNER_PW:-change-me}"
APP_PW="${APP_PW:-change-me}"

psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'giddy_owner') THEN
    CREATE ROLE giddy_owner LOGIN PASSWORD '${OWNER_PW}' NOSUPERUSER NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'giddy_app') THEN
    CREATE ROLE giddy_app LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;
END
\$\$;
SQL

if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME} OWNER giddy_owner"
fi
psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO giddy_app; GRANT ALL ON SCHEMA public TO giddy_owner;"
echo "Database ${DB_NAME} ready."
