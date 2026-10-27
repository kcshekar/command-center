import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const {
  fetchCalendarEvents,
  fetchGoogleTasks,
  fetchCCDueReminders,
  postNotification,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

// N15 weather + R15 line: optional extras that already return null on any
// failure, so one attempt — a retry would only delay the brief.
const { fetchWeatherBrief, draftAffirmation } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface MorningBriefInput {
  userEmail: string;
  slackRouteKey: string; // e.g. "automations.digest"
  userId?: string;       // P3+ schedules pass it; needed for weather (BYOK key + profile city)
}

export async function morningBriefWorkflow(input: MorningBriefInput): Promise<void> {
  const [events, tasks, dueReminders, weather] = await Promise.all([
    fetchCalendarEvents(input.userEmail, 24),
    fetchGoogleTasks(input.userEmail),
    fetchCCDueReminders(7),
    input.userId ? fetchWeatherBrief(input.userId) : Promise.resolve(null),
  ]);
  const note = await draftAffirmation({ weekday: WEEKDAYS[new Date().getDay()], eventCount: events.length });

  const lines: string[] = [`*Morning brief — ${new Date().toISOString().slice(0, 10)}*`];
  if (weather?.length) lines.push("", "*Weather*", ...weather);

  lines.push("", "*Today's events*");
  if (events.length === 0) lines.push("_none_");
  else for (const e of events) lines.push(`• ${e.start} — ${e.summary}`);

  lines.push("", "*Open tasks*");
  if (tasks.length === 0) lines.push("_none_");
  else for (const t of tasks) lines.push(`• ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ""}`);

  lines.push("", "*Reminders due (next 7 days)*");
  if (dueReminders.length === 0) lines.push("_none_");
  else for (const r of dueReminders) lines.push(`• ${r.title} — ${r.due_on.slice(0, 10)} (${r.category})`);

  if (note) lines.push("", `_${note}_`);

  await postNotification(input.slackRouteKey, lines.join("\n"));
}
