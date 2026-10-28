import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

const { ingestLearningReleases, draftAndPostLearningDigest } = routedActivities({
  // Classify + draft each hit Ollama; weekly digest can span many lessons.
  startToCloseTimeout: "6 minutes",
  retry: { maximumAttempts: 2, initialInterval: "15s" },
});

// A8 full pipeline — fetch → persist → classify → draft → Slack.
export async function learningIngestWorkflow(input: {
  userId: string;
  daysBack?: number;
  perRepo?: number;
  classify?: boolean;
  draft?: boolean;
  routeKey?: string;
}): Promise<{
  goals: number; fetched: number; stored: number; classified: number; failed: number;
  drafted: boolean; briefId?: string; skippedReason?: string;
}> {
  const r = await ingestLearningReleases({
    userId: input.userId,
    daysBack: input.daysBack,
    perRepo: input.perRepo,
    classify: input.classify,
  });

  if (input.draft === false || input.classify === false) {
    return { ...r, drafted: false, skippedReason: "draft disabled or classify skipped" };
  }

  const d = await draftAndPostLearningDigest({
    userId: input.userId,
    lessons: r.lessons,
    routeKey: input.routeKey,
  });

  return {
    goals: r.goals, fetched: r.fetched, stored: r.stored, classified: r.classified, failed: r.failed,
    drafted: d.drafted, briefId: d.briefId, skippedReason: d.skippedReason,
  };
}
