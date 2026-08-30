# Database backup & restore

## Requirements

`pg_dump` and `pg_restore` (Postgres client tools) on PATH. On macOS:

```
brew install libpq
echo 'export PATH="/usr/local/opt/libpq/bin:$PATH"' >> ~/.zshrc   # Apple Silicon: /opt/homebrew/opt/libpq/bin
```

## Backup

```
bun run db:backup
```

Reads `DATABASE_URL` from the environment, or from the repo-root `.env` if not already set. Writes a timestamped custom-format dump to `backups/command_center_<timestamp>.dump` (gitignored — these contain your data, don't commit them). Dumps older than `BACKUP_RETENTION_DAYS` (default 30) are pruned automatically after each successful run.

Schedule it with cron for unattended backups, e.g. nightly at 2am:

```
0 2 * * * cd /path/to/memoryAllocator && bun run db:backup >> /var/log/command-center-backup.log 2>&1
```

The dump is taken with `--no-owner --no-privileges`: role names (and their passwords) differ across environments, so ownership/grants are never captured in the dump — restore always ends with re-running `bootstrap-app-role.ts` instead, which is idempotent and safe to run on a fresh or existing database.

## Restore

```
bun run db:restore <backup-file> <target-database-url>
```

The target must be passed explicitly — the script never falls back to `DATABASE_URL`, so a stale environment variable can't cause a restore into the wrong database. It also requires typing the target database's name back as confirmation before touching anything, since `pg_restore --clean` drops existing objects in the target before recreating them.

Steps for a full disaster-recovery restore onto a fresh Postgres instance:

1. Create an empty database: `createdb command_center` (or via whatever admin tooling the host provides).
2. Restore the dump into it:
   ```
   bun run db:restore backups/command_center_20260101_020000.dump \
     "postgres://admin_user:password@host:5432/command_center"
   ```
3. The restore script's final step tells you to re-run the app-role bootstrap — do it, pointed at the same target:
   ```
   DATABASE_URL="postgres://admin_user:password@host:5432/command_center" \
     bun run apps/api/scripts/bootstrap-app-role.ts
   ```
   This (re)creates the restricted `command_center_app` role if needed and grants it the same table privileges as a fresh install (including the `audit_log` append-only restriction).
4. Point `APP_DATABASE_URL` (the app's own runtime connection) at the restored database using the `command_center_app` role's credentials, and `DATABASE_URL` at the admin role, same as any other environment.
5. Sanity-check the restore before trusting it:
   ```sql
   SELECT count(*) FROM users;
   SELECT count(*) FROM audit_log;
   SELECT max(created_at) FROM audit_log;  -- should match roughly when the backup was taken
   ```
6. Start the app and confirm login works and RLS is still enforced (e.g. `bun run apps/api/scripts/bootstrap-app-role.ts` output should show no errors, and the app should run as the restricted role, not the admin one — see `core/db.ts`).

## Test your backups

A backup you've never restored is not a backup. Periodically restore the latest dump into a scratch database (`createdb command_center_restore_test`, restore into it, run the sanity queries above, `dropdb command_center_restore_test`) so a broken backup process is caught before an actual incident, not during one.
