import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";

// Idempotent: creates the morning-brief schedule if missing, updates it if
// present. Run once after deploying; safe to re-run.

async function main() {
  const userEmail = process.argv[2];
  const skipTriage = process.argv.includes("--skip-triage");
  if (!userEmail) {
    console.error("usage: pnpm schedules:init -- <user@gmail.com> [--skip-triage]");
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "personal";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";
  const digest = process.env.SLACK_ROUTE_DIGEST ?? "automations.digest";
  const newsRoute = process.env.NEWS_ALERT_ROUTE_KEY ?? digest;
  // Worker's own pool lives in the automations DB, not commandcenter where
  // users lives — so pass the uuid in via env rather than resolve by email here.
  const newsUserId = process.env.NEWS_USER_ID;

  const approval = process.env.SLACK_ROUTE_APPROVAL ?? "automations.approval";

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  // Temporal parses cron strings in UTC unless the spec names a timezone.
  // All our cadences (morning brief, evening wrap, daily poll) are wall-clock
  // in the user's local zone — IST at home — so set it once up front.
  const scheduleTimezone = process.env.SCHEDULE_TIMEZONE ?? "Asia/Kolkata";

  // D1: catchup 1h so downtime doesn't stack a week of missed runs.
  const commonPolicies = { catchupWindow: "1 hour" as const, overlap: ScheduleOverlapPolicy.SKIP };

  await upsertSchedule(client, {
    scheduleId: "morning-brief-daily",
    cron: "30 7 * * *", // 07:30
    workflowType: "morningBriefWorkflow",
    args: [{ userEmail, slackRouteKey: digest }],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  await upsertSchedule(client, {
    scheduleId: "evening-wrap-daily",
    cron: "0 20 * * *", // 20:00
    workflowType: "eveningWrapWorkflow",
    args: [{ userEmail, slackRouteKey: digest }],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  // P1 #6: polling replacement for the unbuilt Gmail push subscription.
  // 15-min cadence keeps unread noise manageable without hammering Google.
  // SKIP overlap keeps a slow LLM classification from stacking runs.
  if (!skipTriage) {
    await upsertSchedule(client, {
      scheduleId: "inbox-triage-every-15m",
      cron: "*/15 * * * *",
      workflowType: "inboxTriageWorkflow",
      args: [{ userEmail, digestRouteKey: digest, approvalRouteKey: approval }],
      taskQueue,
      policies: commonPolicies,
      timezone: scheduleTimezone,
    });
  } else {
    console.log("skipping inbox-triage-every-15m schedule (--skip-triage)");
  }

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
    cron: "0 */6 * * *",
    workflowType: "ttdPrepWorkflow",
    args: [{}],
    taskQueue,
    policies: commonPolicies,
    timezone: scheduleTimezone,
  });

  // A8 weekly learning digest — Mon 08:00 IST (catalog default).
  // Reuses NEWS_USER_ID — same primary user. Split envs when we need per-user.
  if (newsUserId) {
    await upsertSchedule(client, {
      scheduleId: "a8-learning-weekly",
      cron: "0 8 * * 1",
      workflowType: "learningIngestWorkflow",
      args: [{ userId: newsUserId, daysBack: 7, perRepo: 5, classify: true, draft: true, routeKey: process.env.LEARNING_ALERT_ROUTE_KEY ?? digest }],
      taskQueue,
      policies: commonPolicies,
      timezone: scheduleTimezone,
    });
  } else {
    console.log("skipping a8-learning-weekly schedule (NEWS_USER_ID not set)");
  }

  // A1 tech news draft — Mon + Thu at 09:00 IST (catalog default).
  // Fetches HN top, classifies, drafts a LinkedIn-ready post, Slacks it.
  // Set NEWS_USER_ID in services/automations-worker/.env to the owning user's
  // uuid; skipped if unset (so the init script stays safe to run anywhere).
  if (newsUserId) {
    await upsertSchedule(client, {
      scheduleId: "a1-news-mon-thu",
      cron: "0 9 * * 1,4",
      workflowType: "newsIngestWorkflow",
      args: [{ userId: newsUserId, limit: 15, classify: true, draft: true, minImportance: 4, routeKey: newsRoute }],
      taskQueue,
      policies: commonPolicies,
      timezone: scheduleTimezone,
    });
  } else {
    console.log("skipping a1-news-mon-thu schedule (NEWS_USER_ID not set)");
  }

  await connection.close();
}

async function upsertSchedule(
  client: Client,
  s: { scheduleId: string; cron: string; workflowType: string; args: unknown[]; taskQueue: string; policies: any; timezone: string }
) {
  const action = { type: "startWorkflow" as const, workflowType: s.workflowType, args: s.args, taskQueue: s.taskQueue };
  const spec = { cronExpressions: [s.cron], timezoneName: s.timezone };
  try {
    await client.schedule.create({
      scheduleId: s.scheduleId,
      action,
      spec,
      policies: s.policies,
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
