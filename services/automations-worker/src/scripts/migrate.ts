import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../db.js";

// ponytail: numbered .sql files + a schema_migrations table. Upgrade to a
// framework only if we need down-migrations.

async function main() {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
