import { cc } from "../cc-client.js";
import { inr, todayIn } from "../money-dates.js";

// N5 — daily spend report. CC totals the day by category in SQL (zone is
// required on the read); this activity only formats, flags and posts. No LLM:
// llama3.2:3b kept adding unsupported judgements ("within your typical
// budget") next to exact figures, so the closing line is computed instead.

export interface DayCategory {
  category: string;
  totalCents: string;        // bigint as text
  count: number;
  avgDailyCents30d: number;  // trailing 30-day daily average for the category
  baselineDays: number;      // days in those 30 with spend in the category
}

export const SPIKE_FACTOR = 2;       // flag a category above 2× its usual day…
export const MIN_BASELINE_DAYS = 3;  // …only when there's a real baseline (one stray purchase isn't "usual")

export const isSpike = (c: DayCategory) =>
  c.baselineDays >= MIN_BASELINE_DAYS && c.avgDailyCents30d > 0 && Number(c.totalCents) / c.avgDailyCents30d >= SPIKE_FACTOR;

/** Pure: the Slack/in-app text for one day, or null when nothing was spent. */
export function formatSpendReport(
  day: { date: string; zone: "personal" | "professional"; categories: DayCategory[] },
  note?: string | null,
): string | null {
  if (day.categories.length === 0) return null;
  const total = day.categories.reduce((t, c) => t + Number(c.totalCents), 0);
  const count = day.categories.reduce((t, c) => t + c.count, 0);
  const label = new Date(`${day.date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  const lines = [
    `*Today's spending — ${label}* (${day.zone === "personal" ? "personal" : "business"})`,
    `${inr(total)} across ${count} expense${count === 1 ? "" : "s"}`,
  ];
  for (const c of day.categories) {
    const cents = Number(c.totalCents);
    const flag = isSpike(c) ? ` · ⚠️ ${(cents / c.avgDailyCents30d).toFixed(1)}× your usual day` : "";
    lines.push(`• ${c.category} — ${inr(cents)}${flag}`);
  }
  if (note) lines.push("", `_${note}_`);
  return lines.join("\n");
}

/** Pure: the closing line — which categories ran above their usual day, or nothing. */
export function spikeLine(flagged: DayCategory[]): string | null {
  if (flagged.length === 0) return null;
  const names = flagged.map((c) => c.category);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${names.length === 1 ? "was" : "were"} higher than your usual day.`;
}

export async function buildDailySpendReport(input: {
  userId: string;
  zone: "personal" | "professional";
  routeKey: string;
  date?: string;
}): Promise<{ posted: boolean; total: number; flagged: number }> {
  const date = input.date ?? todayIn();
  const day = await cc.dailyExpenses(input.userId, input.zone, date);
  if (day.categories.length === 0) {
    console.log("[n5.spend] nothing spent", { date, zone: input.zone });
    return { posted: false, total: 0, flagged: 0 };
  }

  const flagged = day.categories.filter(isSpike);
  const note = spikeLine(flagged);

  const text = formatSpendReport({ date, zone: input.zone, categories: day.categories }, note)!;
  await cc.notify(input.routeKey, text);
  return { posted: true, total: day.categories.reduce((t, c) => t + Number(c.totalCents), 0), flagged: flagged.length };
}
