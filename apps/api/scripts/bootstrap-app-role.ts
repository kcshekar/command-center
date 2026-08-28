import { SQL } from "bun";

// Idempotent, safe to re-run on any environment. Provisions the restricted
// role the running API connects as (APP_DATABASE_URL) — non-superuser so
// Postgres RLS actually applies, and deliberately denied UPDATE/DELETE on
// audit_log so the append-only guarantee holds even against SQL run through
// this exact role, not just via app-layer discipline.
const ROLE = "command_center_app";
const DB_NAME = "command_center";

const admin = new SQL(process.env.DATABASE_URL!);

const [existing] = await admin`SELECT rolname FROM pg_roles WHERE rolname = ${ROLE}`;
if (!existing) {
  const password = crypto.randomUUID().replace(/-/g, "");
  await admin.unsafe(
    `CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
  );
  console.log(`created role ${ROLE}`);
  console.log(`APP_DATABASE_URL password: ${password}  (set this in .env)`);
} else {
  console.log(`role ${ROLE} already exists, leaving password unchanged`);
}

await admin.unsafe(`GRANT CONNECT ON DATABASE ${DB_NAME} TO ${ROLE}`);
await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
await admin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
await admin.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`);

// audit_log is append-only: revoke the two privileges the blanket grant above
// just handed out. This is enforced at the privilege level, not via RLS —
// RLS with no UPDATE/DELETE policy defaults to *allow*, not deny.
await admin.unsafe(`REVOKE UPDATE, DELETE ON audit_log FROM ${ROLE}`);
await admin.unsafe(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${ROLE}`);

console.log("privileges applied");
await admin.close();
