import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSpendReport, spikeLine } from "./spend-report.js";

test("spend report: totals, flags only above 2x a real baseline, empty day posts nothing", () => {
  const text = formatSpendReport({
    date: "2026-10-27",
    zone: "personal",
    categories: [
      { category: "food", totalCents: "120000", count: 2, avgDailyCents30d: 50000, baselineDays: 12 },  // 2.4× → flagged
      { category: "fuel", totalCents: "99400", count: 1, avgDailyCents30d: 60000, baselineDays: 4 },    // 1.7× → not
      { category: "gifts", totalCents: "50000", count: 1, avgDailyCents30d: 0, baselineDays: 0 },       // no baseline → not
      { category: "shopping", totalCents: "144432", count: 2, avgDailyCents30d: 1523, baselineDays: 1 }, // 94× on one stray day → not
    ],
  }, "A food-heavy day.");
  assert.ok(text);
  assert.match(text!, /₹4,138 across 6 expenses/);
  assert.match(text!, /• food — ₹1,200 · ⚠️ 2\.4× your usual day/);
  assert.match(text!, /• fuel — ₹994$/m);
  assert.match(text!, /• gifts — ₹500$/m);
  assert.match(text!, /• shopping — ₹1,444$/m);
  assert.match(text!, /_A food-heavy day\._$/);
  assert.equal(formatSpendReport({ date: "2026-10-27", zone: "personal", categories: [] }), null);
});

test("spike line: computed, never drafted", () => {
  const c = (category: string) => ({ category, totalCents: "1", count: 1, avgDailyCents30d: 1, baselineDays: 5 });
  assert.equal(spikeLine([]), null);
  assert.equal(spikeLine([c("food")]), "Food was higher than your usual day.");
  assert.equal(spikeLine([c("food"), c("fuel"), c("travel")]), "Food, fuel and travel were higher than your usual day.");
});
