import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import pg from "pg";

// Idempotent one-command setup for a fresh host. Uses an admin connection
// (CREATEDB + CREATEROLE needed — CC's DATABASE_URL has them after this
// session's earlier bootstrap). Creates the automations DB + runtime role,
// applies every migration, prints the finished AUTOMATIONS_DATABASE_URL for
// you to paste into the worker's .env.
//
// Usage:
//   ADMIN_DATABASE_URL=postgres://cc_admin:...@host:5432/postgres \
//     pnpm bootstrap

const DB_NAME = "automations";
const ROLE = "automations_app";

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error(
    "ADMIN_DATABASE_URL must be set — a Postgres URL with CREATEDB + CREATEROLE.\n" +
      "Hint: your CC DATABASE_URL already has these; just point it at the 'postgres' db:\n" +
      "  ADMIN_DATABASE_URL=\"postgres://cc_admin:...@<host>:5432/postgres\" pnpm bootstrap"
  );
  process.exit(1);
}

// Admin pool points at the server's default `postgres` db for CREATE DATABASE
// (can't CREATE DATABASE from inside the DB you're creating).
const serverUrl = new URL(adminUrl);
serverUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: serverUrl.toString() });

async function ensureDatabase(): Promise<void> {
  const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]);
  if (rows.length > 0) {
    console.log(`database ${DB_NAME} already exists`);
    return;
  }
  // Identifier interpolation — can't parameterize DDL. DB_NAME is a const literal
  // in this file so no injection surface; still write it as an identifier.
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(DB_NAME)}`);
  console.log(`created database ${DB_NAME}`);
}

async function ensureRole(): Promise<string | null> {
  const { rows } = await admin.query(`SELECT rolname FROM pg_roles WHERE rolname = $1`, [ROLE]);
  if (rows.length > 0) {
    console.log(`role ${ROLE} already exists, leaving password unchanged`);
    return null;
  }
  const password = randomBytes(24).toString("hex");
  // Password escaped by SQL-literal rules — pg_escape_literal would be ideal
  // but node-postgres only ships escapeIdentifier. Hex randomness means no
  // single quotes in the password, so safe to interpolate directly.
  await admin.query(
    `CREATE ROLE ${pg.escapeIdentifier(ROLE)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`
  );
  console.log(`created role ${ROLE}`);
  return password;
}

async function grantPrivileges(): Promise<void> {
  await admin.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(DB_NAME)} TO ${pg.escapeIdentifier(ROLE)}`);
}

async function applyMigrations(): Promise<void> {
  // Reconnect to the new DB — schema ops live there, not in `postgres`.
  const targetUrl = new URL(adminUrl!);
  targetUrl.pathname = `/${DB_NAME}`;
  const target = new pg.Pool({ connectionString: targetUrl.toString() });

  try {
    await target.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Give the runtime role the usage + default privileges it needs. Done
    // here (inside the target DB) because schema-level grants aren't visible
    // from the `postgres` db.
    await target.query(`GRANT USAGE ON SCHEMA public TO ${pg.escapeIdentifier(ROLE)}`);
    await target.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${pg.escapeIdentifier(ROLE)}`
    );
    await target.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${pg.escapeIdentifier(ROLE)}`
    );

    const migDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
    const applied = new Set((await target.query(`SELECT id FROM schema_migrations`)).rows.map((r) => r.id));
    const files = (await readdir(migDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      console.log(`applying ${file}`);
      const sql = await readFile(join(migDir, file), "utf8");
      const client = await target.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        // Re-grant on newly created tables (CREATE in a tx doesn't retroactively
        // apply default privileges to objects created in the same tx on all PG versions).
        await target.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${pg.escapeIdentifier(ROLE)}`
        );
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await target.end();
  }
}

async function main() {
  await ensureDatabase();
  const newPassword = await ensureRole();
  await grantPrivileges();
  await applyMigrations();

  console.log("");
  console.log("─────────────────────────────────────────────");
  if (newPassword) {
    const u = new URL(adminUrl!);
    u.username = ROLE;
    u.password = newPassword;
    u.pathname = `/${DB_NAME}`;
    console.log("paste this into services/automations-worker/.env :");
    console.log("");
    console.log(`  AUTOMATIONS_DATABASE_URL=${u.toString()}`);
  } else {
    console.log(`role ${ROLE} already existed. Keep the AUTOMATIONS_DATABASE_URL you have.`);
  }
  console.log("─────────────────────────────────────────────");

  await admin.end();
}

main().catch(async (err) => {
  console.error(err);
  await admin.end().catch(() => {});
  process.exit(1);
});
