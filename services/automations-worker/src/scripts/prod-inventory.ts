import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";

// Read-only snapshot of a deployment for the prod-sync checklist: versions,
// env var NAMES that are missing/empty (never values), migrations not yet
// applied, Temporal schedules, Ollama/Chrome reachability. Changes nothing.
// Run from services/automations-worker:  pnpm inventory

const worker = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(worker, "../..");
const readEnv = (p: string) => (existsSync(p) ? dotenv.parse(readFileSync(p)) : null);
const cc = readEnv(join(root, ".env"));
const w = readEnv(join(worker, ".env"));

const CC_REQUIRED = [
  "DATABASE_URL", "APP_DATABASE_URL", "REDIS_URL", "SESSION_SECRET", "SLACK_ENCRYPTION_SECRET",
  "WORKER_CALLBACK_URL", "WORKER_CALLBACK_TOKEN", "API_ORIGIN", "USER_CREDENTIALS_DEK", "PILGRIM_IDENTITIES_DEK",
  "TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", // grant toggles create per-user schedules
  "CHROME_PATH", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", // CA invoice PDFs + email
  "GCS_BUCKET_NAME", "GCS_SERVICE_ACCOUNT_KEY", "OLLAMA_HOST",
];
const W_REQUIRED = [
  "AUTOMATIONS_DATABASE_URL", "AUTOMATIONS_ENCRYPTION_SECRET",
  "TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_TASK_QUEUE", "CC_BASE_URL",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
  "OLLAMA_HOST", "OLLAMA_MODEL", "WORKER_CALLBACK_PORT", "WORKER_CALLBACK_TOKEN",
];

const sh = (cmd: string) => {
  try { return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "not found"; }
};

function envReport(label: string, env: Record<string, string> | null, names: string[]) {
  if (!env) return console.log(`${label} env: .env NOT FOUND`);
  const gaps = names.filter((n) => !env[n]?.trim());
  console.log(`${label} env: ${gaps.length ? `missing/empty → ${gaps.join(", ")}` : "all required set"}`);
}

async function migrations(label: string, url: string | undefined, dir: string) {
  if (!url) return console.log(`${label} migrations: no database URL`);
  const pool = new pg.Pool({ connectionString: url });
  try {
    const { rows } = await pool.query("SELECT id FROM schema_migrations ORDER BY id");
    const applied = new Set(rows.map((r) => r.id as string));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const pending = files.filter((f) => !applied.has(f));
    const unknown = [...applied].filter((id) => !files.includes(id));
    console.log(
      `${label} migrations: ${applied.size} applied (last ${rows.at(-1)?.id ?? "none"}); pending ${pending.length}` +
        (pending.length ? `: ${pending.join(", ")}` : "") +
        (unknown.length ? `; applied but not in repo: ${unknown.join(", ")}` : ""),
    );
  } catch (err) {
    console.log(`${label} migrations: ERROR ${String((err as Error).message).slice(0, 120)}`);
  } finally {
    await pool.end();
  }
}

async function schedules() {
  if (!w?.TEMPORAL_ADDRESS) return console.log("schedules: no TEMPORAL_ADDRESS");
  const connection = await Connection.connect({ address: w.TEMPORAL_ADDRESS });
  try {
    const client = new Client({ connection, namespace: w.TEMPORAL_NAMESPACE ?? "personal" });
    const rows: string[] = [];
    for await (const s of client.schedule.list()) {
      const type = s.action && "workflowType" in s.action ? s.action.workflowType : "?";
      rows.push(`  ${s.state.paused ? "paused " : "ACTIVE "} ${s.scheduleId}  (${type})`);
    }
    console.log(`schedules in ${w.TEMPORAL_NAMESPACE}: ${rows.length}`);
    for (const r of rows.sort()) console.log(r);
  } finally {
    await connection.close();
  }
}

async function ollama() {
  const host = w?.OLLAMA_HOST;
  if (!host) return console.log("ollama: no OLLAMA_HOST");
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const { models = [] } = (await res.json()) as { models?: Array<{ name: string }> };
    const want = w?.OLLAMA_MODEL ?? "llama3.2:3b";
    const tagged = want.includes(":") ? want : `${want}:latest`; // Ollama lists untagged models as :latest
    console.log(`ollama: reachable; model ${want} ${models.some((m) => m.name === tagged) ? "present" : "MISSING"}`);
  } catch (err) {
    console.log(`ollama: NOT reachable from this machine (${String((err as Error).message).slice(0, 60)})`);
  }
}

async function main() {
  console.log(`commit ${sh("git rev-parse --short HEAD")} · uncommitted files ${sh("git status --porcelain | wc -l")}`);
  console.log(`node ${process.version} · bun ${sh("bun --version")} · pnpm ${sh("pnpm --version")}`);
  envReport("CC", cc, CC_REQUIRED);
  envReport("worker", w, W_REQUIRED);
  // Equality only (no values): these pairs must match or calls/schedules break.
  if (cc && w) {
    console.log(`WORKER_CALLBACK_TOKEN matches: ${cc.WORKER_CALLBACK_TOKEN === w.WORKER_CALLBACK_TOKEN}`);
    const queue = (e: Record<string, string>) => e.TEMPORAL_TASK_QUEUE || "personal-automations"; // both sides' default
    console.log(`TEMPORAL_NAMESPACE matches: ${cc.TEMPORAL_NAMESPACE === w.TEMPORAL_NAMESPACE} · task queue matches: ${queue(cc) === queue(w)}`);
  }
  // pnpm migrate: ADMIN_DATABASE_URL, else the main .env DATABASE_URL
  console.log(`worker migrate admin: ${w?.ADMIN_DATABASE_URL ? "ADMIN_DATABASE_URL" : cc?.DATABASE_URL ? "main .env DATABASE_URL" : "NONE (migrate will fail)"}`);
  console.log(`chrome at CHROME_PATH: ${cc?.CHROME_PATH ? existsSync(cc.CHROME_PATH) : "unset"}`);
  await migrations("CC", cc?.DATABASE_URL ?? cc?.APP_DATABASE_URL, join(root, "apps/api/migrations"));
  await migrations("worker", w?.AUTOMATIONS_DATABASE_URL, join(worker, "migrations"));
  await ollama();
  await schedules().catch((err) => console.log(`schedules: ERROR ${String(err?.message ?? err).slice(0, 120)}`));
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
