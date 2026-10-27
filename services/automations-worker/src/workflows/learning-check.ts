import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

// N8 — weekly learning check (catalog n8.learncheck, Friday 19:00 IST).
const { buildLearningCheck } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

export async function learningCheckWorkflow(input: { userId: string; routeKey: string }) {
  return buildLearningCheck(input);
}

