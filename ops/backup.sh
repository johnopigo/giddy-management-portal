#!/usr/bin/env bash
# Backs up the portal database (docker compose deployment) to backups/giddy-<date>.dump,
# checks the file can be read back, and deletes backups older than KEEP_DAYS.
# Run from the repository folder, e.g. nightly from cron:
#   15 2 * * *  cd /opt/giddy && ops/backup.sh >> backups/backup.log 2>&1
# Copy the backups off this machine too (BACKUP_COPY_CMD is run with the new file's path), e.g.
#   BACKUP_COPY_CMD='rclone copy --immutable "$1" offsite:giddy-backups' ops/backup.sh
set -euo pipefail
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/giddy-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$file.partial"
compose exec -T db pg_dump -U postgres -d giddy --format=custom --compress=9 > "$tmp"
# A dump that cannot be listed is not a backup.
compose exec -T db pg_restore --list < "$tmp" > /dev/null
mv "$tmp" "$file"
chmod 600 "$file"
echo "$(date -u +%FT%TZ) backup written: $file ($(du -h "$file" | cut -f1))"

if [[ -n "${BACKUP_COPY_CMD:-}" ]]; then
  bash -c "$BACKUP_COPY_CMD" _ "$file"
  echo "$(date -u +%FT%TZ) copied off-site"
fi
find "$BACKUP_DIR" -name 'giddy-*.dump' -type f -mtime +"$KEEP_DAYS" -print -delete
