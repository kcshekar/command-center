import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";

// Idempotent: creates the org-wide SYSTEM schedules if missing, updates them
// if present (pause state is preserved). Run once after deploying; safe to re-run.
// New schedules are always created PAUSED — turn each on from the Control room.
//
// Per-user automations (morning brief, evening wrap, inbox triage, calendar
// sync, news, jobs, profile, learning) are no longer created here: turning an
// automation on in Command Center creates "<automationId>:<userId>[:<email>]"
// schedules from automation_catalog.schedule_template (P3, migration 0045).

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "personal";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";
  const digest = process.env.SLACK_ROUTE_DIGEST ?? "automations.digest";

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  // Temporal parses cron strings in UTC unless the spec names a timezone.
  // All our cadences (morning brief, evening wrap, daily poll) are wall-clock
  // in the user's local zone — IST at home — so set it once up front.
  const scheduleTimezone = process.env.SCHEDULE_TIMEZONE ?? "Asia/Kolkata";

  // D1: catchup 1h so downtime doesn't stack a week of missed runs.
  const commonPolicies = { catchupWindow: "1 hour" as const, overlap: ScheduleOverlapPolicy.SKIP };

  // A6 daily poll — org-wide. One run per day iterates every active watch,
  // writes back snapshots via CC. Verdict transitions post to the configured
  // notification route (defaults to the digest).
  await upsertSchedule(client, {
    scheduleId: "price-watch-daily-poll",
    cron: "0 7 * * *", // 07:00 local, before the morning brief
    workflowType: "priceWatchDailyPollWorkflow",
    args: [],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  // A10 TTD prep — every 6h. Scans ttd_windows for anything whose booking
  // release is imminent and Slacks the pilgrim pack.
  await upsertSchedule(client, {
    scheduleId: "ttd-prep-every-6h",
    cron: "35 */6 * * *", // P0.3: off the :00/:30 slots (see CC migration 0067)
    workflowType: "ttdPrepWorkflow",
    args: [{}],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  // Pgvector embedder — hourly sweep. Picks up to N unembedded knowledge_items
  // across all users in the org and embeds them on the local Ollama
  // (nomic-embed-text, P2.0). Paused until turned on from the dashboard.
  await upsertSchedule(client, {
    scheduleId: "knowledge-embedder-hourly",
    cron: "44 * * * *", // P0.3 stagger
    workflowType: "knowledgeEmbedderWorkflow",
    args: [{ limit: 20 }],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  // A4 interview reminders — every 15 min. Pings upcoming rounds in next 24h
  // (one Slack message per round, max once per 24h via metadata.notifiedAt).
  await upsertSchedule(client, {
    scheduleId: "a4-interview-reminders-15m",
    cron: "11-59/15 * * * *", // P0.3: a5.mail runs at :02/:17/:32/:47
    workflowType: "interviewRemindersWorkflow",
    args: [{ withinHours: 24, renotifyHours: 24, routeKey: process.env.INTERVIEW_ALERT_ROUTE_KEY ?? digest }],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  // A11 monthly upgrade scan — 1st of month at 11:00 IST (catalog default).
  // No per-user state; runs org-wide. Review-only — never auto-upgrades.
  await upsertSchedule(client, {
    scheduleId: "a11-upgrader-monthly",
    cron: "0 11 1 * *",
    workflowType: "platformUpgradeScanWorkflow",
    args: [{ routeKey: process.env.PLATFORM_UPGRADE_ROUTE_KEY ?? digest }],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  // N14 weekly dependency security scan — Monday 09:30 IST.
  await upsertSchedule(client, {
    scheduleId: "n14-security-weekly",
    cron: "30 9 * * 1",
    workflowType: "securityScanWorkflow",
    args: [{ routeKey: process.env.PLATFORM_UPGRADE_ROUTE_KEY ?? digest }],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  await connection.close();
}

async function upsertSchedule(
  client: Client,
  s: { scheduleId: string; cron: string; workflowType: string; args: unknown[]; taskQueue: string; policies: any; timezone: string }
) {
  const action = { type: "startWorkflow" as const, workflowType: s.workflowType, args: s.args, taskQueue: s.taskQueue };
  const spec = { cronExpressions: [s.cron], timezone: s.timezone }; // SDK field is `timezone`; `timezoneName` (the proto name) is silently ignored
  try {
    await client.schedule.create({
      scheduleId: s.scheduleId,
      action,
      spec,
      policies: s.policies,
      state: { paused: true, note: "created paused — turn on from the Control room" },
    });
    console.log(`created schedule ${s.scheduleId} (${s.timezone})`);
  } catch (err) {
    if (!String((err as any)?.message ?? err).includes("already exists")) throw err;
    // Also re-apply spec so the timezone update takes effect on existing
    // schedules created before this field was set.
    await client.schedule.getHandle(s.scheduleId).update((prev) => ({ ...prev, action, spec }));
    console.log(`updated existing schedule ${s.scheduleId} (${s.timezone})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
