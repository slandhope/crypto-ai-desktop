#!/usr/bin/env bash
# RDS / Postgres logical backup helper (run on a machine with DB access).
# Usage:
#   export DATABASE_URL='postgres://...'
#   ./scripts/rds-backup.sh
# Optional: BACKUP_DIR=/var/backups/asuka RETENTION_DAYS=14
set -euo pipefail
DIR="${BACKUP_DIR:-./backups}"
KEEP="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DIR"
OUT="$DIR/asuka-$STAMP.sql.gz"
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Set DATABASE_URL first" >&2
  exit 1
fi
echo "Backing up to $OUT"
pg_dump "$DATABASE_URL" | gzip -c > "$OUT"
echo "OK $(du -h "$OUT" | awk '{print $1}')"
# prune
find "$DIR" -name 'asuka-*.sql.gz' -mtime +"$KEEP" -delete 2>/dev/null || true
echo "Pruned backups older than ${KEEP}d"
