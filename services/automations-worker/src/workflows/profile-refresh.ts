import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

const { refreshProfileDrafts } = routedActivities({
  // One structured LLM call + a couple of CC writes. Local Ollama → budget
  // room for larger responses.
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 2, initialInterval: "20s" },
});

export async function profileRefreshWorkflow(input: {
  userId: string;
  recentDays?: number;
  routeKey?: string;
}): Promise<{ status: string; drafted: number; briefIds?: string[]; skippedReason?: string }> {
  return refreshProfileDrafts(input);
}
