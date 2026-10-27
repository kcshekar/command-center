import { test } from "node:test";
import assert from "node:assert/strict";
import { caBatchCard, previousMonth } from "./ca-card.js";

test("N12: previous month across a year boundary; card summary with capped body", () => {
  assert.equal(previousMonth("2026-11-05"), "2026-10");
  assert.equal(previousMonth("2027-01-05"), "2026-12");
  const { text, summary } = caBatchCard({
    batchId: "b1", project: "CUVA", periodMonth: "2026-10", invoiceCount: 2, totals: "4200.00 USD",
    recipientEmail: "ca@example.com", subject: "Export invoices for October 2026", body: "x".repeat(700),
  });
  assert.equal(text, "CA invoices for October 2026: CUVA (2)");
  assert.match(summary, /^\*CUVA — October 2026\*: 2 invoices, 4200\.00 USD\nTo: ca@example\.com\nSubject: Export invoices for October 2026\n\n/);
  assert.ok(summary.endsWith("x".repeat(600) + "…"));
});
