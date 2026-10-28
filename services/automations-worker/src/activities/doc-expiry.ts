import { cc, type DueReminder } from "../cc-client.js";
import { daysBetween, todayIn } from "../money-dates.js";

// R2 — document expiry, on top of Reminders (decision 2026-10-27). Alerts on
// the exact day a threshold is crossed so a daily run says each thing once:
// 60, 30, 15 and 7 days out, then every day for the last 3 days and on the
// day, then daily for a week after it lapses. Titles only — no document numbers.

export const EXPIRY_CATEGORIES = new Set(["document", "insurance", "vehicle"]);
const MILESTONES = new Set([60, 30, 15, 7]);
const LAPSED_DAYS = 7;

export function alertsFor(reminders: DueReminder[], today: string): Array<{ title: string; category: string; daysLeft: number }> {
  return reminders
    .filter((r) => EXPIRY_CATEGORIES.has(r.category))
    .map((r) => ({ title: r.title, category: r.category, daysLeft: daysBetween(today, r.due_on.slice(0, 10)) }))
    .filter(({ daysLeft }) => MILESTONES.has(daysLeft) || (daysLeft <= 3 && daysLeft >= -LAPSED_DAYS))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

export function formatExpiry(alerts: ReturnType<typeof alertsFor>): string | null {
  if (alerts.length === 0) return null;
  const when = (d: number) =>
    d < 0 ? `⚠️ expired ${-d} day${d === -1 ? "" : "s"} ago` : d === 0 ? "⚠️ expires today" : d <= 3 ? `⚠️ expires in ${d} day${d === 1 ? "" : "s"}` : `expires in ${d} days`;
  return ["*Expiring soon*", ...alerts.map((a) => `• ${a.title} (${a.category}) — ${when(a.daysLeft)}`)].join("\n");
}

export async function buildDocumentExpiryReport(input: { userId: string; routeKey: string; date?: string }) {
  const today = input.date ?? todayIn();
  // The reminders due endpoint covers up to 60 days ahead and includes overdue.
  const text = formatExpiry(alertsFor(await cc.dueReminders(60, input.userId), today));
  if (!text) {
    console.log("[r2.docs] nothing expiring on a milestone today");
    return { posted: false };
  }
  await cc.notify(input.routeKey, text);
  return { posted: true };
}
