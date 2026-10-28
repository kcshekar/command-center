import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

const { researchJobLeadForInterview } = routedActivities({
  // One structured LLM call + a couple of CC writes.
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 2, initialInterval: "20s" },
});

// A3.prep — triggered on-demand from the Jobs UI when the user clicks "Prep".
// Returns the created session + knowledge_item ids so the UI can jump
// straight to them.
export async function interviewPrepWorkflow(input: {
  userId: string;
  jobLeadId: string;
}): Promise<{ status: string; sessionId?: string; briefId?: string; skippedReason?: string }> {
  return researchJobLeadForInterview(input);
}
