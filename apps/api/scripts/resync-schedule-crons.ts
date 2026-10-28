import { sql } from "../core/db";
import { temporalClient } from "../core/temporal";

// Pushes each catalog template's cron onto the per-user Temporal schedules
// ("<automationId>:<userId>[:<email>]") already created from it. Spec only:
// args and pause state are untouched. Idempotent; run after a cron migration:
//   bun --env-file=.env apps/api/scripts/resync-schedule-crons.ts [--dry-run]
const dryRun = process.argv.includes("--dry-run");
const timezoneName = process.env.SCHEDULE_TIMEZONE ?? "Asia/Kolkata";

const rows = await sql`SELECT id, schedule_template->>'cron' AS cron FROM automation_catalog WHERE schedule_template IS NOT NULL`;
const cronById = new Map<string, string>(rows.map((r: { id: string; cron: string }) => [r.id, r.cron]));

const client = await temporalClient();
let updated = 0;
for await (const s of client.schedule.list()) {
  const cron = cronById.get(s.scheduleId.split(":")[0]);
  if (!s.scheduleId.includes(":") || !cron) continue;
  console.log(`${dryRun ? "would set" : "set"} ${s.scheduleId} → ${cron}`);
  if (!dryRun) await client.schedule.getHandle(s.scheduleId).update((prev) => ({ ...prev, spec: { cronExpressions: [cron], timezone: timezoneName } }));
  updated++;
}
console.log(`${updated} schedule(s) ${dryRun ? "to update" : "updated"}`);
process.exit(0);
