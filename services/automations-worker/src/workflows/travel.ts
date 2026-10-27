import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

// R14 — trip pack (catalog r14.travel, hourly; trips 23–24h out).
const { buildTripPack } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

export async function tripPackWorkflow(input: { userId: string; routeKey: string }) {
  return buildTripPack(input);
}
