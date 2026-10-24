import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { prepareTtdReminders } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "90 seconds",
  retry: { maximumAttempts: 3, initialInterval: "10s" },
});

// A10.3 — tiny wrapper. All work (fetch due, resolve pilgrims, Slack, mark
// notified) lives in the activity, so the workflow is just the schedule
// entry point.
export async function ttdPrepWorkflow(input: { withinHours?: number; renotifyHours?: number } = {}): Promise<{
  due: number; notified: number; failed: number;
}> {
  return prepareTtdReminders(input);
}
