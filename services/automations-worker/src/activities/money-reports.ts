import { cc } from "../cc-client.js";
import { addDays, daysBetween, dueWithin, inr, nextDue, todayIn, type BillTiming } from "../money-dates.js";

// Tier 1 money reports — all arithmetic, no AI (decision 2026-10-27). Each
// has a pure formatter (tested) and a thin activity that reads CC, formats
// and posts. Personal zone only. A formatter returning null = nothing to say,
// so nothing is posted.
//
//   R13 subscriptions  daily: 3-day renewal heads-up; on the 25th the monthly total
//   N9  bill forecast  Sunday: bills due in 30 days vs. account balances
//   R10 budget check   Friday: month-to-date spend vs. prorated budget

export interface Bill extends BillTiming {
  id: string;
  name: string;
  amountCents: string;
  currency: string;
  category: string;
}

const short = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

// --- R13 -------------------------------------------------------------------

export const RENEWAL_NOTICE_DAYS = 3;
export const SUMMARY_DAY = 25;

/** Monthly-equivalent cost: yearly spread over 12, weekly ×52/12. */
export function monthlyCents(b: Bill): number {
  const a = Number(b.amountCents);
  return b.cadence === "yearly" ? a / 12 : b.cadence === "weekly" ? (a * 52) / 12 : a;
}

export function formatSubscriptions(bills: Bill[], today: string): string | null {
  const subs = bills.filter((b) => b.category.toLowerCase() === "subscription");
  if (subs.length === 0) return null;
  const lines: string[] = [];

  const renewing = subs.filter((b) => {
    const d = nextDue(b, today);
    return d !== null && daysBetween(today, d) === RENEWAL_NOTICE_DAYS;
  });
  if (renewing.length) {
    lines.push(`*Renewing in ${RENEWAL_NOTICE_DAYS} days* (${short(addDays(today, RENEWAL_NOTICE_DAYS))})`);
    for (const b of renewing) lines.push(`• ${b.name} — ${inr(Number(b.amountCents))} (${b.cadence})`);
  }

  if (Number(today.slice(8, 10)) === SUMMARY_DAY) {
    const total = subs.reduce((t, b) => t + monthlyCents(b), 0);
    if (lines.length) lines.push("");
    lines.push(`*Subscriptions this month:* ${inr(total)} across ${subs.length} (${inr(total * 12)} a year)`);
    for (const b of [...subs].sort((x, y) => monthlyCents(y) - monthlyCents(x))) {
      const per = b.cadence === "monthly" ? "" : ` (${inr(Number(b.amountCents))} ${b.cadence})`;
      lines.push(`• ${b.name} — ${inr(monthlyCents(b))}/month${per}`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

// --- N9 --------------------------------------------------------------------

export interface Balance { name: string; balanceCents: string; balanceUpdatedAt: string }

export function formatBillForecast(bills: Bill[], balances: Balance[], today: string, days: number): string | null {
  const due = bills
    .flatMap((b) => dueWithin(b, today, days).map((on) => ({ on, b })))
    .sort((x, y) => x.on.localeCompare(y.on));
  const undated = bills.filter((b) => nextDue(b, today) === null);
  if (due.length === 0 && undated.length === 0) return null;

  const total = due.reduce((t, d) => t + Number(d.b.amountCents), 0);
  const lines = [`*Bills due in the next ${days} days:* ${inr(total)} across ${due.length} payment${due.length === 1 ? "" : "s"}`];
  for (const d of due) lines.push(`• ${short(d.on)} — ${d.b.name} ${inr(Number(d.b.amountCents))}`);
  if (undated.length) lines.push(`_No due date set: ${undated.map((b) => b.name).join(", ")}. Add one in Finance to include them._`);

  lines.push("");
  if (balances.length === 0) {
    lines.push("Set a balance on your accounts in Finance → Personal → Accounts to get a shortfall check.");
  } else {
    const have = balances.reduce((t, b) => t + Number(b.balanceCents), 0);
    const oldest = balances.map((b) => b.balanceUpdatedAt).sort()[0];
    const age = daysBetween(oldest.slice(0, 10), today);
    lines.push(`Balance on your accounts: ${inr(have)} (oldest update ${age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`})`);
    lines.push(have >= total ? `✓ Covered, with ${inr(have - total)} to spare.` : `⚠️ Short by ${inr(total - have)}.`);
  }
  return lines.join("\n");
}

// --- R10 -------------------------------------------------------------------

export interface BudgetStatus { category: string; limitCents: string; spentCents: string }

export function formatBudgets(budgets: BudgetStatus[], today: string): string | null {
  if (budgets.length === 0) return null;
  const [y, m, d] = today.split("-").map(Number);
  const monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lines = [`*Budgets — ${d} of ${monthDays} days into the month*`];
  for (const b of budgets) {
    const limit = Number(b.limitCents);
    const spent = Number(b.spentCents);
    const paced = (limit * d) / monthDays;
    const pct = Math.round((spent / paced) * 100);
    const state = spent > limit ? " · ⚠️ over the monthly budget" : spent > paced ? " · ⚠️ ahead of pace" : "";
    lines.push(`• ${b.category} — ${inr(spent)} of ${inr(paced)} so far (${inr(limit)}/month) · ${pct}%${state}`);
  }
  return lines.join("\n");
}

// --- activities --------------------------------------------------------------

type Input = { userId: string; routeKey: string; date?: string };

async function post(routeKey: string, text: string | null, tag: string): Promise<{ posted: boolean }> {
  if (!text) {
    console.log(`[${tag}] nothing to report`);
    return { posted: false };
  }
  await cc.notify(routeKey, text);
  return { posted: true };
}

export async function buildSubscriptionsReport(input: Input) {
  const today = input.date ?? todayIn();
  const bills = await cc.financeBills(input.userId, "personal");
  return post(input.routeKey, formatSubscriptions(bills, today), "r13.subs");
}

export async function buildBillForecast(input: Input & { days?: number }) {
  const today = input.date ?? todayIn();
  const [bills, balances] = await Promise.all([
    cc.financeBills(input.userId, "personal"),
    cc.financeBalances(input.userId, "personal"),
  ]);
  return post(input.routeKey, formatBillForecast(bills, balances, today, input.days ?? 30), "n9.bills");
}

export async function buildBudgetReport(input: Input) {
  const today = input.date ?? todayIn();
  const { budgets } = await cc.financeBudgets(input.userId, today);
  return post(input.routeKey, formatBudgets(budgets, today), "r10.budget");
}
