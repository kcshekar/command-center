import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

const { openGithubPrFromKnowledgeItem } = routedActivities({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2, initialInterval: "15s" },
});

// A7 — user triggers from Profile Drafts with a target repo. Workflow spans
// ~5 GitHub REST calls; retrying is safe because branch creation is idempotent
// by name (we timestamp it).
export async function githubPrFromKnowledgeItemWorkflow(input: {
  userId: string;
  knowledgeItemId: string;
  repo: string;
  path?: string;
  prTitle?: string;
  prBody?: string;
}): Promise<{
  status: string;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  reason?: string;
}> {
  return openGithubPrFromKnowledgeItem(input);
}
