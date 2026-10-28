import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

const { sweepUnembeddedKnowledgeItems } = routedActivities({
  // 10 OpenAI calls round-trip. ~5s typical.
  startToCloseTimeout: "90 seconds",
  retry: { maximumAttempts: 2, initialInterval: "20s" },
});

export async function knowledgeEmbedderWorkflow(input: { limit?: number } = {}): Promise<{
  queued: number; embedded: number; skipped: number; failed: number;
}> {
  return sweepUnembeddedKnowledgeItems(input);
}
