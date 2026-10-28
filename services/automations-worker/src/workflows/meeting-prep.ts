import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

// N13 — meeting prep (catalog n13.meetings, every 30 min per pinned account).
const { buildMeetingPrep } = routedActivities({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

export async function meetingPrepWorkflow(input: { userId: string; userEmail: string; routeKey: string }) {
  return buildMeetingPrep(input);
}
