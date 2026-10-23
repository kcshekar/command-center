import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { fetchInitialPriceSnapshot, listDuePriceWatches } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "45 seconds",
  retry: { maximumAttempts: 3, initialInterval: "5s" },
});

export interface InitialFetchInput {
  watchId: string;
  userId: string;
  source: string;
  externalId: string | null;
  url: string;
}

// One-shot: pull the first price snapshot right after the user adds a watch.
// Daily poll is a separate workflow + schedule — this one just gets a price
// on the row so the UI stops saying "fetching…".
export async function priceWatchInitialFetchWorkflow(input: InitialFetchInput): Promise<{ status: string; price?: number }> {
  return fetchInitialPriceSnapshot(input);
}

// A6 Phase 2.6 — daily sweep: ask CC for every unpaused watch that hasn't
// been checked in ~20h and call the same single-watch activity for each.
// Sequential to keep Keepa token spend predictable; parallelism is cheap to
// add later if someone has hundreds of watches.
// ponytail: sequential fan-out, swap to Promise.all with a semaphore if Keepa
// rate limits start to bite.
export async function priceWatchDailyPollWorkflow(): Promise<{
  total: number;
  ok: number;
  skipped: number;
  failed: number;
}> {
  const due = await listDuePriceWatches();
  let ok = 0, skipped = 0, failed = 0;
  for (const w of due) {
    try {
      const r = await fetchInitialPriceSnapshot(w);
      if (r.status === "ok") ok++;
      else skipped++;
    } catch {
      failed++;
    }
  }
  return { total: due.length, ok, skipped, failed };
}
