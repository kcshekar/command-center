import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { ingestAdzunaJobs, draftAndPostJobsDigest } = wf.proxyActivities<typeof activities>({
  // Fetch + upsert + sequential LLM scores + digest draft on local Ollama.
  startToCloseTimeout: "8 minutes",
  retry: { maximumAttempts: 2, initialInterval: "15s" },
});

// A2 full pipeline — fetch → upsert → classify → draft → Slack.
export async function jobsIngestWorkflow(input: {
  userId: string;
  country?: string;
  resultsPerPage?: number;
  classify?: boolean;
  draft?: boolean;
  minScore?: number;
  routeKey?: string;
}): Promise<{
  status: string; fetched: number; stored: number; scored: number; failed: number;
  keywords?: string; country?: string;
  drafted: boolean; briefId?: string; skippedReason?: string;
}> {
  const r = await ingestAdzunaJobs({
    userId: input.userId,
    country: input.country,
    resultsPerPage: input.resultsPerPage,
    classify: input.classify,
  });

  if (input.draft === false || input.classify === false || r.leads.length === 0) {
    return { ...r, drafted: false, skippedReason: input.draft === false ? "draft disabled" : "nothing to draft" };
  }

  const d = await draftAndPostJobsDigest({
    userId: input.userId,
    leads: r.leads,
    minScore: input.minScore,
    routeKey: input.routeKey,
  });

  return {
    status: r.status, fetched: r.fetched, stored: r.stored, scored: r.scored, failed: r.failed,
    keywords: r.keywords, country: r.country,
    drafted: d.drafted, briefId: d.briefId, skippedReason: d.skippedReason,
  };
}
