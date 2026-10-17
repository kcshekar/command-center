import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

// ponytail: numbered .sql files + a schema_migrations table. Upgrade to a
// framework only if we need down-migrations.
//
// Uses ADMIN_DATABASE_URL (the role that owns the schema, same as bootstrap)
// — the runtime automations_app role has no CREATE privilege, so applying
// DDL through the shared pool fails with "permission denied for schema public".

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const runtimeUrl = process.env.AUTOMATIONS_DATABASE_URL;
  if (!adminUrl && !runtimeUrl) throw new Error("ADMIN_DATABASE_URL or AUTOMATIONS_DATABASE_URL must be set");

  // Prefer ADMIN; fall back to runtime URL pointed at the same DB (works only
  // if the runtime role happens to own the schema, i.e. fresh installs where
  // bootstrap wasn't used).
  const url = adminUrl
    ? pointAt(adminUrl, dbNameOf(runtimeUrl ?? adminUrl))
    : runtimeUrl!;

  const pool = new pg.Pool({ connectionString: url });
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await pool.query(`SELECT id FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.id));

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    console.log(`applying ${file}`);
    const sql = await readFile(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  console.log("migrations up to date");
  await pool.end();
}

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "") || "automations";
}

function pointAt(baseUrl: string, dbName: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
