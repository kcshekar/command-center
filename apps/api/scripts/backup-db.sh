#!/usr/bin/env bash
# Dumps the Postgres database into ./backups (repo root), custom format
# (compressed, supports parallel/selective restore). Reads DATABASE_URL from
# the environment, or from .env at the repo root if not already set.
#
# Usage: apps/api/scripts/backup-db.sh
# Env:   BACKUP_RETENTION_DAYS (default 30) — dumps older than this are pruned
#        after a successful backup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [[ -z "${DATABASE_URL:-}" && -f "$REPO_ROOT/.env" ]]; then
  # Only pull DATABASE_URL, not the whole file — avoids clobbering other
  # env vars already set in the caller's shell.
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env" | head -1 | cut -d= -f2-)"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL not set and not found in $REPO_ROOT/.env" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump not found on PATH. Install the Postgres client tools (e.g. 'brew install libpq' and add its bin/ to PATH)." >&2
  exit 1
fi

BACKUP_DIR="$REPO_ROOT/backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
OUT_FILE="$BACKUP_DIR/command_center_${TIMESTAMP}.dump"

echo "Backing up to $OUT_FILE ..."
# --no-owner/--no-privileges: role names differ across environments (dev's
# 'localuser' vs prod's admin role) — the restore script re-grants app-role
# privileges itself via bootstrap-app-role.ts rather than trusting the dump
# to carry the right role names.
pg_dump --format=custom --no-owner --no-privileges --file="$OUT_FILE" "$DATABASE_URL"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "Backup complete: $OUT_FILE ($SIZE)"

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
find "$BACKUP_DIR" -name 'command_center_*.dump' -mtime "+${RETENTION_DAYS}" -print -delete
