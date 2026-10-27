import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLearningCheck } from "./learning-check.js";

test("N8: per-goal counts, must-reads, quiet goals; nothing without goals", () => {
  const since = "2026-10-20T00:00:00.000Z";
  const l = (title: string, target: string, createdAt: string, priority?: string, url?: string) =>
    ({ title, createdAt, metadata: { target, url, classification: priority ? { priority } : undefined } });
  const text = formatLearningCheck(
    [
      l("Next 16.3", "vercel/next.js", "2026-10-24T09:00:00Z", "must", "https://x/next"),
      l("Bun 1.4.4", "oven-sh/bun", "2026-10-22T09:00:00Z", "skim"),
      l("Old one", "oven-sh/bun", "2026-10-10T09:00:00Z", "must"), // before the week → ignored
    ],
    [
      { target: "vercel/next.js", sourceKind: "github_release" },
      { target: "oven-sh/bun", sourceKind: "github_release" },
      { target: "https://blog.cloudflare.com/rss/", sourceKind: "rss" },
    ],
    since,
  )!;
  assert.match(text, /2 items across 3 goals/);
  assert.match(text, /• vercel\/next\.js — 1 \(1 must-read\)/);
  assert.match(text, /• oven-sh\/bun — 1$/m);
  assert.match(text, /• <https:\/\/x\/next\|Next 16\.3>/);
  assert.doesNotMatch(text, /Old one/);
  assert.match(text, /Nothing new this week for blog\.cloudflare\.com/);
  assert.equal(formatLearningCheck([], [], since), null);
});
