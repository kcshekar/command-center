import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

// N5 — daily spend report. Scheduled per user from the catalog
// (n5.spend, 21:00 IST); all I/O lives in the activity.
const { buildDailySpendReport } = routedActivities({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

export interface DailySpendReportInput {
  userId: string;
  zone: "personal" | "professional";
  routeKey: string;
}

export async function dailySpendReportWorkflow(input: DailySpendReportInput) {
  return buildDailySpendReport(input);
}
