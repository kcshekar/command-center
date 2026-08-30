#!/usr/bin/env bash
# Restores a backup produced by backup-db.sh into a target database.
# Destructive: --clean drops existing objects in the target DB before
# recreating them. Requires the target connection string explicitly (never
# falls back to DATABASE_URL) so a stale env var can't cause a restore into
# the wrong database, plus a typed confirmation before touching anything.
#
# Usage: apps/api/scripts/restore-db.sh <backup-file> <target-database-url>
set -euo pipefail

BACKUP_FILE="${1:-}"
TARGET_DATABASE_URL="${2:-}"

if [[ -z "$BACKUP_FILE" || -z "$TARGET_DATABASE_URL" ]]; then
  echo "Usage: $0 <backup-file> <target-database-url>" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_restore not found on PATH. Install the Postgres client tools (e.g. 'brew install libpq' and add its bin/ to PATH)." >&2
  exit 1
fi

# Redact credentials before echoing the target back to the operator.
DISPLAY_URL="$(echo "$TARGET_DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]*@#\1***@#')"
echo "This will DROP and recreate objects in: $DISPLAY_URL"
echo "Restoring from: $BACKUP_FILE"
read -r -p "Type the database name shown above to confirm: " CONFIRM_NAME
TARGET_DB_NAME="$(echo "$TARGET_DATABASE_URL" | sed -E 's#.*/([^/?]+).*#\1#')"
if [[ "$CONFIRM_NAME" != "$TARGET_DB_NAME" ]]; then
  echo "Confirmation did not match database name '$TARGET_DB_NAME' — aborting." >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" "$BACKUP_FILE"

echo "Restore complete. Now re-run the app-role bootstrap so the restricted"
echo "runtime role (command_center_app) has the right grants on restored tables:"
echo "  DATABASE_URL=\"$TARGET_DATABASE_URL\" bun run apps/api/scripts/bootstrap-app-role.ts"
