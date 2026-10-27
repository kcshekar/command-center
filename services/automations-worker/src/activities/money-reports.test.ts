import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBillForecast, formatBudgets, formatNetWorth, formatSubscriptions, type Bill } from "./money-reports.js";
import { alertsFor, formatExpiry } from "./doc-expiry.js";

const bill = (name: string, amountRs: number, cadence: string, dueDay: number | null, dueMonth: number | null = null, category = "subscription"): Bill =>
  ({ id: name, name, amountCents: String(amountRs * 100), currency: "INR", cadence, dueDay, dueMonth, category });

test("R13: 3-day renewal notice, 25th summary, quiet otherwise", () => {
  const subs = [bill("Netflix", 649, "monthly", 30), bill("Prime", 1499, "yearly", 1, 11), bill("Rent", 20000, "monthly", 1, null, "rent")];
  assert.match(formatSubscriptions(subs, "2026-10-27")!, /Renewing in 3 days\* \(30 Oct\)\n• Netflix — ₹649 \(monthly\)/);
  assert.equal(formatSubscriptions(subs, "2026-10-26"), null);
  const summary = formatSubscriptions(subs, "2026-10-25")!;
  assert.match(summary, /Subscriptions this month:\* ₹774 across 2 \(₹9,287 a year\)/); // 649 + 1499/12; year = 649×12 + 1499
  assert.match(summary, /• Prime — ₹125\/month \(₹1,499 yearly\)/);
  assert.doesNotMatch(summary, /Rent/);
});

test("N9: totals bills in window, covered vs short, nudges when no balance", () => {
  const bills = [bill("BESCOM", 1180, "monthly", 4, null, "utility"), bill("Insurance", 12000, "yearly", 15, 11, "insurance"), bill("Gym", 999, "monthly", null, null, "health")];
  const noBal = formatBillForecast(bills, [], "2026-10-27", 30)!;
  assert.match(noBal, /₹13,180 across 2 payments/);
  assert.match(noBal, /• 4 Nov — BESCOM ₹1,180\n• 15 Nov — Insurance ₹12,000/);
  assert.match(noBal, /No due date set: Gym/);
  assert.match(noBal, /Set a balance/);
  const short = formatBillForecast(bills, [{ name: "HDFC", balanceCents: "1000000", balanceUpdatedAt: "2026-10-24T10:00:00Z" }], "2026-10-27", 30)!;
  assert.match(short, /₹10,000 \(oldest update 3 days ago\)\n⚠️ Short by ₹3,180\./);
  assert.match(formatBillForecast(bills, [{ name: "HDFC", balanceCents: "2000000", balanceUpdatedAt: "2026-10-27T01:00:00Z" }], "2026-10-27", 30)!, /✓ Covered, with ₹6,820 to spare/);
  assert.equal(formatBillForecast([], [], "2026-10-27", 30), null);
});

test("R10: prorated pace, ahead of pace, over budget", () => {
  const text = formatBudgets([
    { category: "food", limitCents: "800000", spentCents: "300000" },     // 27/31 → paced ₹6,968
    { category: "shopping", limitCents: "300000", spentCents: "290000" }, // paced ₹2,613 → ahead
    { category: "fuel", limitCents: "200000", spentCents: "250000" },     // over the month
  ], "2026-10-27")!;
  assert.match(text, /27 of 31 days/);
  assert.match(text, /• food — ₹3,000 of ₹6,968 so far \(₹8,000\/month\) · 43%$/m);
  assert.match(text, /• shopping — .* · ⚠️ ahead of pace$/m);
  assert.match(text, /• fuel — .* · ⚠️ over the monthly budget$/m);
  assert.equal(formatBudgets([], "2026-10-27"), null);
});

test("R2: milestones only, daily in last 3 days and a week after", () => {
  const r = (title: string, category: string, due_on: string) => ({ id: title, title, category, due_on, recurrence: null, notified_at: null });
  const alerts = alertsFor([
    r("Car insurance", "insurance", "2026-11-26"), // 30 days → alert
    r("Passport", "document", "2026-11-25"),       // 29 → quiet
    r("PUC", "vehicle", "2026-10-29"),             // 2 → alert
    r("Licence", "document", "2026-10-20"),        // -7 → alert
    r("Old", "document", "2026-10-19"),            // -8 → quiet
    r("BESCOM", "bill", "2026-10-29"),             // not an expiry category
  ], "2026-10-27");
  assert.deepEqual(alerts.map((a) => [a.title, a.daysLeft]), [["Licence", -7], ["PUC", 2], ["Car insurance", 30]]);
  assert.match(formatExpiry(alerts)!, /• PUC \(vehicle\) — ⚠️ expires in 2 days/);
  assert.equal(formatExpiry([]), null);
});

test("R12: net worth, change since last snapshot, negative net, no balances", () => {
  const now = { on: "2026-11-01", assetsCents: "50000000", liabilitiesCents: "12000000", accounts: 4 };
  const prev = { on: "2026-10-01", assetsCents: "45000000", liabilitiesCents: "13000000", accounts: 4 };
  const text = formatNetWorth(now, prev);
  assert.match(text, /\*Net worth on 1 Nov:\* ₹3,80,000/);
  assert.match(text, /Assets ₹5,00,000 − owed ₹1,20,000, from 4 accounts/);
  assert.match(text, /▲ \+₹60,000 since 1 Oct/);
  assert.match(formatNetWorth({ ...now, assetsCents: "1000000" }, null), /Net worth on 1 Nov:\* −₹1,10,000/);
  assert.match(formatNetWorth(null, null), /set balances on your accounts/);
});
