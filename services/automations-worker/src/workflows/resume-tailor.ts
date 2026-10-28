import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

const { tailorResumeForJobLead } = routedActivities({
  // One structured LLM call + two knowledge_items writes + optional Gmail draft.
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 2, initialInterval: "20s" },
});

// A9.resume — user-triggered from /jobs. Produces a tailored resume + cover
// letter and (if OAuth is live) a Gmail draft, all linked to the originating
// job_lead.
export async function resumeTailorWorkflow(input: {
  userId: string;
  userEmail?: string;
  jobLeadId: string;
}): Promise<{
  status: string;
  resumeKnowledgeItemId?: string;
  coverLetterKnowledgeItemId?: string;
  gmailDraftId?: string;
  gmailDraftSkippedReason?: string;
  skippedReason?: string;
}> {
  return tailorResumeForJobLead(input);
}
