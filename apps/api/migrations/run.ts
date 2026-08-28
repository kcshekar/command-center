import { readdir } from "node:fs/promises";
import { SQL } from "bun";

// Own admin connection, separate from core/db's app-role connection — DDL
// (CREATE TABLE, ALTER ... ENABLE RLS) needs privileges the restricted
// runtime role deliberately doesn't have.
const sql = new SQL(process.env.DATABASE_URL!);

// ponytail: no migration framework — a `schema_migrations` table + sorted .sql
// files is the whole job. Upgrade to Drizzle/Atlas only if we need down-migrations
// or multi-schema coordination.

const dir = new URL(".", import.meta.url).pathname;

async function run() {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

  const applied = new Set(
    (await sql`SELECT id FROM schema_migrations`).map((r: any) => r.id)
  );

  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await Bun.file(`${dir}${file}`).text();
    console.log(`applying ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (id) VALUES (${file})`;
    });
  }

  console.log("migrations up to date");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
