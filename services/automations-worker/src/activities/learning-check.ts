import { cc } from "../cc-client.js";

// N8 — weekly learning check. Closes A8's loop: A8 collects lessons per
// learning goal all week; this counts what arrived per goal, lists the
// must-reads, and names goals that got nothing. Computed only, no AI.

export interface LessonItem {
  title: string;
  createdAt: string;
  metadata: { target?: string; url?: string; classification?: { priority?: string } };
}
export interface Goal { target: string; sourceKind: string }

const MUST_LIST_MAX = 5;

/** Readable goal name: "vercel/next.js" stays; feed URLs become their host. */
function goalName(target: string): string {
  try {
    return target.startsWith("http") ? new URL(target).host : target;
  } catch {
    return target;
  }
}

export function formatLearningCheck(lessons: LessonItem[], goals: Goal[], since: string): string | null {
  if (goals.length === 0) return null;
  const week = lessons.filter((l) => l.createdAt >= since);
  const lines = [`*Learning this week:* ${week.length} item${week.length === 1 ? "" : "s"} across ${goals.length} goal${goals.length === 1 ? "" : "s"}`];

  for (const g of goals) {
    const mine = week.filter((l) => l.metadata.target === g.target);
    const must = mine.filter((l) => l.metadata.classification?.priority === "must").length;
    lines.push(`• ${goalName(g.target)} — ${mine.length}${must ? ` (${must} must-read)` : ""}`);
  }

  const mustReads = week.filter((l) => l.metadata.classification?.priority === "must").slice(0, MUST_LIST_MAX);
  if (mustReads.length) {
    lines.push("", "*Must-reads*");
    for (const l of mustReads) lines.push(`• ${l.metadata.url ? `<${l.metadata.url}|${l.title}>` : l.title}`);
  }

  const quiet = goals.filter((g) => !week.some((l) => l.metadata.target === g.target));
  if (quiet.length) {
    lines.push("", `_Nothing new this week for ${quiet.map((g) => goalName(g.target)).join(", ")}. Still worth following?_`);
  }
  return lines.join("\n");
}

export async function buildLearningCheck(input: { userId: string; routeKey: string; daysBack?: number }) {
  const since = new Date(Date.now() - (input.daysBack ?? 7) * 86_400_000).toISOString();
  const [lessons, goals] = await Promise.all([
    cc.listKnowledgeItems({ userId: input.userId, source: "a8.learning", type: "lesson", limit: 300 }),
    cc.listLearningGoals(input.userId),
  ]);
  const text = formatLearningCheck(lessons as LessonItem[], goals, since);
  if (!text) {
    console.log("[n8.learning] no learning goals");
    return { posted: false };
  }
  await cc.notify(input.routeKey, text);
  return { posted: true };
}
