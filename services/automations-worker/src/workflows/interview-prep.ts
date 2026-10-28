import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

// P2.4 — ReAct company research. Several local-model calls on CPU (~1–3 min).
const { researchCompanyForInterview } = routedActivities({
  startToCloseTimeout: "8 minutes",
  retry: { maximumAttempts: 1 },   // research is optional: on failure the draft runs without it
});

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
  // P2.0b: patched() so runs started before this deploy replay without the new step.
  let research: string | undefined;
  if (wf.patched("interview-prep-react-v1")) {
    research = (await researchCompanyForInterview(input).catch(() => null))?.research || undefined;
  }
  return researchJobLeadForInterview({ ...input, research });
}
