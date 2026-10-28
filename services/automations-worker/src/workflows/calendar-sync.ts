import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

const { syncGoogleCalendarInterviews } = routedActivities({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2, initialInterval: "15s" },
});

// A4 — hourly scan of the user's calendar for the next ~30 days. Matches
// events against known interview_sessions by company name; upserts rounds
// idempotently per calendarEventId.
export async function calendarInterviewSyncWorkflow(input: {
  userId: string;
  userEmail: string;
  daysAhead?: number;
}): Promise<{ scanned: number; matched: number; created: number; updated: number; skipped: number }> {
  return syncGoogleCalendarInterviews(input);
}
