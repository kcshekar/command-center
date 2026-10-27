import { cc } from "../cc-client.js";
import { ollamaJson, ollamaText } from "../ollama.js";
import { daysBetween, nextDue, todayIn } from "../money-dates.js";

// R3 — birthdays & anniversaries. A week ahead: heads-up + gift ideas; on the
// day: a message draft. Dates are plain math (yearly nextDue, Feb 29 → 28).
// Ideas and drafts come from the LOCAL model only and are optional — a model
// failure drops those lines, never the reminder itself.

export interface Occasion {
  person: string;
  relationship: string | null;
  kind: "birthday" | "anniversary" | "other";
  month: number;
  day: number;
  year: number | null;
  notes: string | null;
}

export const HEADS_UP_DAYS = 7;

export function dueOccasions(list: Occasion[], today: string) {
  return list
    .map((o) => {
      const on = nextDue({ cadence: "yearly", dueDay: o.day, dueMonth: o.month }, today)!;
      const daysLeft = daysBetween(today, on);
      const turning = o.year ? Number(on.slice(0, 4)) - o.year : null;
      return { o, on, daysLeft, turning };
    })
    .filter((x) => x.daysLeft === HEADS_UP_DAYS || x.daysLeft === 0)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

function what(x: ReturnType<typeof dueOccasions>[number]): string {
  const { o, turning } = x;
  if (o.kind === "birthday") return `${o.person}'s birthday${turning ? ` (turning ${turning})` : ""}`;
  if (o.kind === "anniversary") return `${o.person} — anniversary${turning ? ` (${turning} years)` : ""}`;
  return o.person;
}

export function formatOccasions(
  due: ReturnType<typeof dueOccasions>,
  extras: Map<string, { ideas?: string[]; draft?: string }>,
): string | null {
  if (due.length === 0) return null;
  const lines: string[] = [];
  for (const x of due) {
    const e = extras.get(x.o.person + x.o.kind) ?? {};
    if (lines.length) lines.push("");
    if (x.daysLeft === 0) {
      lines.push(`🎉 *Today: ${what(x)}*`);
      if (e.draft) lines.push(`Draft message: _${e.draft}_`);
    } else {
      const label = new Date(`${x.on}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      lines.push(`*In a week (${label}): ${what(x)}*`);
      if (e.ideas?.length) lines.push(...e.ideas.map((i) => `• ${i}`));
    }
  }
  return lines.join("\n");
}

const IDEAS_SCHEMA = {
  type: "object",
  required: ["ideas"],
  properties: { ideas: { type: "array", items: { type: "string" }, maxItems: 3 } },
} as const;

async function extrasFor(x: ReturnType<typeof dueOccasions>[number]): Promise<{ ideas?: string[]; draft?: string }> {
  const { o, turning } = x;
  const who = `${o.person}${o.relationship ? ` (my ${o.relationship})` : ""}`;
  const about = [turning ? `turning ${turning}` : "", o.notes ? `notes: ${o.notes}` : ""].filter(Boolean).join("; ");
  try {
    if (x.daysLeft === 0) {
      const draft = await ollamaText(
        `Write a warm, short ${o.kind === "other" ? "" : o.kind + " "}message (max 2 sentences) to ${who}. ${about}. ` +
        `Plain text, no emojis, no hashtags, no quotes, no sign-off.`,
        { temperature: 0.7 },
      );
      return { draft: draft.replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 300) };
    }
    const out = await ollamaJson(
      `Suggest exactly 3 thoughtful gift ideas for ${who}'s ${o.kind}. ${about}. ` +
      `Each idea under 10 words, concrete, no prices. Return JSON {"ideas": [..]}.`,
      IDEAS_SCHEMA,
    );
    const ideas = Array.isArray(out?.ideas) ? out.ideas.filter((i: unknown) => typeof i === "string").slice(0, 3) : [];
    return { ideas };
  } catch (err) {
    console.warn("[r3.occasions] local model skipped", String(err));
    return {};
  }
}

export async function buildOccasionsReport(input: { userId: string; routeKey: string; date?: string }) {
  const today = input.date ?? todayIn();
  const due = dueOccasions(await cc.occasions(input.userId), today);
  if (due.length === 0) return { posted: false };
  const extras = new Map<string, { ideas?: string[]; draft?: string }>();
  for (const x of due) extras.set(x.o.person + x.o.kind, await extrasFor(x));
  await cc.notify(input.routeKey, formatOccasions(due, extras)!);
  return { posted: true, count: due.length };
}
