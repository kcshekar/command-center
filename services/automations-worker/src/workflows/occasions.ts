import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

// R3 — birthdays & anniversaries (catalog r3.occasions, daily 08:00 IST).
// Longer timeout: up to one local-model call per occasion due today.
const { buildOccasionsReport } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 2 },
});

export async function occasionsWorkflow(input: { userId: string; routeKey: string }) {
  return buildOccasionsReport(input);
}
