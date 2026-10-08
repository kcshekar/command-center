import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const {
  fetchCalendarEvents,
  fetchGoogleTasks,
  fetchCCDueReminders,
  postSlackMessage,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

export interface MorningBriefInput {
  userEmail: string;
  slackRouteKey: string; // e.g. "automations.digest"
}

export async function morningBriefWorkflow(input: MorningBriefInput): Promise<void> {
  const [events, tasks, dueReminders] = await Promise.all([
    fetchCalendarEvents(input.userEmail, 24),
    fetchGoogleTasks(input.userEmail),
    fetchCCDueReminders(7),
  ]);

  const lines: string[] = [`*Morning brief — ${new Date().toISOString().slice(0, 10)}*`];

  lines.push("", "*Today's events*");
  if (events.length === 0) lines.push("_none_");
  else for (const e of events) lines.push(`• ${e.start} — ${e.summary}`);

  lines.push("", "*Open tasks*");
  if (tasks.length === 0) lines.push("_none_");
  else for (const t of tasks) lines.push(`• ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ""}`);

  lines.push("", "*Reminders due (next 7 days)*");
  if (dueReminders.length === 0) lines.push("_none_");
  else for (const r of dueReminders) lines.push(`• ${r.title} — ${r.due_on.slice(0, 10)} (${r.category})`);

  await postSlackMessage(input.slackRouteKey, lines.join("\n"));
}
