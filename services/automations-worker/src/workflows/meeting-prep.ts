import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

// N13 — meeting prep (catalog n13.meetings, every 30 min per pinned account).
const { buildMeetingPrep } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

export async function meetingPrepWorkflow(input: { userId: string; userEmail: string; routeKey: string }) {
  return buildMeetingPrep(input);
}
