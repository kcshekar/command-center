import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { fetchCompletedTasksToday, rolloverOverdueTasks, postSlackMessage } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

export interface EveningWrapInput {
  userEmail: string;
  slackRouteKey: string; // typically "automations.digest"
}

export async function eveningWrapWorkflow(input: EveningWrapInput): Promise<{ completed: number; rolled: number }> {
  // P0 #2: degrade gracefully — one Google API blip shouldn't skip the whole
  // digest. Post whatever we got and flag what didn't.
  const results = await Promise.allSettled([
    fetchCompletedTasksToday(input.userEmail),
    rolloverOverdueTasks(input.userEmail),
  ]);
  const completed = results[0].status === "fulfilled" ? results[0].value : null;
  const rolled = results[1].status === "fulfilled" ? results[1].value : null;

  const lines: string[] = ["🌆 *Evening wrap-up*"];

  lines.push("", "*Completed today:*");
  if (completed === null) lines.push("_unavailable — Google Tasks fetch failed_");
  else if (completed.length === 0) lines.push("_none_");
  else for (const t of completed) lines.push(`• ✅ ${t.title}`);

  lines.push("", "*Rolled to tomorrow:*");
  if (rolled === null) lines.push("_unavailable — Google Tasks rollover failed_");
  else if (rolled.length === 0) lines.push("_none_");
  else for (const r of rolled) lines.push(`• ⏩ ${r.title} (was due ${r.from})`);

  await postSlackMessage(input.slackRouteKey, lines.join("\n"));
  return { completed: completed?.length ?? 0, rolled: rolled?.length ?? 0 };
}
