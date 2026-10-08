import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";

// Idempotent: creates the morning-brief schedule if missing, updates it if
// present. Run once after deploying; safe to re-run.

async function main() {
  const userEmail = process.argv[2];
  if (!userEmail) {
    console.error("usage: npm run schedules:init -- <user@gmail.com>");
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "personal";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";
  const digest = process.env.SLACK_ROUTE_DIGEST ?? "automations.digest";

  const approval = process.env.SLACK_ROUTE_APPROVAL ?? "automations.approval";

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  // D1: catchup 1h so downtime doesn't stack a week of missed runs.
  const commonPolicies = { catchupWindow: "1 hour" as const, overlap: ScheduleOverlapPolicy.SKIP };

  await upsertSchedule(client, {
    scheduleId: "morning-brief-daily",
    cron: "30 7 * * *", // 07:30
    workflowType: "morningBriefWorkflow",
    args: [{ userEmail, slackRouteKey: digest }],
    taskQueue,
    policies: commonPolicies,
  });

  await upsertSchedule(client, {
    scheduleId: "evening-wrap-daily",
    cron: "0 20 * * *", // 20:00
    workflowType: "eveningWrapWorkflow",
    args: [{ userEmail, slackRouteKey: digest }],
    taskQueue,
    policies: commonPolicies,
  });

  // P1 #6: polling replacement for the unbuilt Gmail push subscription.
  // 15-min cadence keeps unread noise manageable without hammering Google.
  // SKIP overlap keeps a slow LLM classification from stacking runs.
  await upsertSchedule(client, {
    scheduleId: "inbox-triage-every-15m",
    cron: "*/15 * * * *",
    workflowType: "inboxTriageWorkflow",
    args: [{ userEmail, digestRouteKey: digest, approvalRouteKey: approval }],
    taskQueue,
    policies: commonPolicies,
  });

  await connection.close();
}

async function upsertSchedule(
  client: Client,
  s: { scheduleId: string; cron: string; workflowType: string; args: unknown[]; taskQueue: string; policies: any }
) {
  const action = { type: "startWorkflow" as const, workflowType: s.workflowType, args: s.args, taskQueue: s.taskQueue };
  try {
    await client.schedule.create({
      scheduleId: s.scheduleId,
      action,
      spec: { cronExpressions: [s.cron] },
      policies: s.policies,
    });
    console.log(`created schedule ${s.scheduleId}`);
  } catch (err) {
    if (!String((err as any)?.message ?? err).includes("already exists")) throw err;
    await client.schedule.getHandle(s.scheduleId).update((prev) => ({ ...prev, action }));
    console.log(`updated existing schedule ${s.scheduleId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
