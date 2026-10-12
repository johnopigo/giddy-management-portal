#!/usr/bin/env bash
# Restores the portal database from a backup made by ops/backup.sh, replacing what is there now,
# then checks every tenant's audit chain is intact. The portal is stopped while this runs.
#   ops/restore.sh backups/giddy-20261012T021500Z.dump --yes
set -euo pipefail
ENV_FILE="${ENV_FILE:-.env.production}"
file="${1:-}"
if [[ -z "$file" || ! -f "$file" ]]; then echo "Usage: ops/restore.sh <backup.dump> --yes" >&2; exit 2; fi
if [[ "${2:-}" != "--yes" ]]; then
  echo "This REPLACES the current database with $file. Run again with --yes to go ahead." >&2; exit 2
fi
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

compose exec -T db pg_restore --list < "$file" > /dev/null   # readable before anything is dropped
compose stop app
compose exec -T db dropdb -U postgres --if-exists --force giddy
compose exec -T db createdb -U postgres -O giddy_owner giddy
compose exec -T db pg_restore -U postgres -d giddy --exit-on-error < "$file"
echo "Restored $file. Checking the audit trail…"
broken=$(compose exec -T db psql -U postgres -d giddy -tAc \
  "SELECT string_agg(name || ' (first bad entry ' || b || ')', ', ') FROM (SELECT t.name, sec.audit_verify_chain(t.id) AS b FROM tenant t) x WHERE b IS NOT NULL")
if [[ -n "$broken" ]]; then
  echo "WARNING: the audit chain is broken for: $broken. The portal stays stopped; investigate before starting it." >&2
  exit 1
fi
echo "Audit trail intact."
compose start app
echo "Portal started."
