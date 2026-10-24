import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { ingestHnTopStories, draftAndPostNewsBrief } = wf.proxyActivities<typeof activities>({
  // Classification + draft each run through Ollama; budget headroom.
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 2, initialInterval: "15s" },
});

// A1 full pipeline: fetch HN top → persist as knowledge_items → classify each
// → build a LinkedIn draft from the kept ones → post to Slack. Each stage is
// optional (classify/draft) so a tuning run can skip to just ingest.
export async function newsIngestWorkflow(input: {
  userId: string;
  limit?: number;
  classify?: boolean;
  draft?: boolean;
  minImportance?: number;
  routeKey?: string;
}): Promise<{
  fetched: number; stored: number; classified: number; failed: number;
  drafted: boolean; briefId?: string; skippedReason?: string;
}> {
  const r = await ingestHnTopStories({
    userId: input.userId,
    limit: input.limit,
    classify: input.classify,
  });

  // Draft only if we classified something — ingest-only runs just report counts.
  if (input.draft === false || input.classify === false) {
    return { ...r, drafted: false, skippedReason: "draft disabled or classify skipped" };
  }
  const d = await draftAndPostNewsBrief({
    userId: input.userId,
    stories: r.stories,
    minImportance: input.minImportance,
    routeKey: input.routeKey,
  });
  return {
    fetched: r.fetched, stored: r.stored, classified: r.classified, failed: r.failed,
    drafted: d.drafted, briefId: d.briefId, skippedReason: d.skippedReason,
  };
}
