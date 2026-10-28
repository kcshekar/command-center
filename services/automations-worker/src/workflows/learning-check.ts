import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

// N8 — weekly learning check (catalog n8.learncheck, Friday 19:00 IST).
const { buildLearningCheck } = routedActivities({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

export async function learningCheckWorkflow(input: { userId: string; routeKey: string }) {
  return buildLearningCheck(input);
}

