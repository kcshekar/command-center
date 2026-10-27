import { test } from "node:test";
import assert from "node:assert/strict";
import { daysBetween, dueWithin, nextDue } from "./money-dates.js";

test("nextDue: monthly, yearly, weekly, short months, missing timing", () => {
  assert.equal(nextDue({ cadence: "monthly", dueDay: 5, dueMonth: null }, "2026-10-27"), "2026-11-05");
  assert.equal(nextDue({ cadence: "monthly", dueDay: 27, dueMonth: null }, "2026-10-27"), "2026-10-27");
  assert.equal(nextDue({ cadence: "monthly", dueDay: 31, dueMonth: null }, "2026-11-01"), "2026-11-30");
  assert.equal(nextDue({ cadence: "monthly", dueDay: 31, dueMonth: null }, "2027-02-01"), "2027-02-28");
  assert.equal(nextDue({ cadence: "yearly", dueDay: 15, dueMonth: 3 }, "2026-10-27"), "2027-03-15");
  assert.equal(nextDue({ cadence: "yearly", dueDay: 15, dueMonth: 11 }, "2026-10-27"), "2026-11-15");
  assert.equal(nextDue({ cadence: "weekly", dueDay: 1, dueMonth: null }, "2026-10-27"), "2026-11-02"); // Tue → next Mon
  assert.equal(nextDue({ cadence: "weekly", dueDay: 2, dueMonth: null }, "2026-10-27"), "2026-10-27"); // Tue → today
  assert.equal(nextDue({ cadence: "yearly", dueDay: 15, dueMonth: null }, "2026-10-27"), null);
  assert.equal(nextDue({ cadence: "monthly", dueDay: null, dueMonth: null }, "2026-10-27"), null);
});

test("dueWithin + daysBetween", () => {
  assert.deepEqual(dueWithin({ cadence: "monthly", dueDay: 28, dueMonth: null }, "2026-10-27", 35), ["2026-10-28", "2026-11-28"]);
  assert.deepEqual(dueWithin({ cadence: "weekly", dueDay: 5, dueMonth: null }, "2026-10-27", 30), ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"]); // Fridays through 26 Nov
  assert.deepEqual(dueWithin({ cadence: "yearly", dueDay: 1, dueMonth: 6 }, "2026-10-27", 30), []);
  assert.equal(daysBetween("2026-10-27", "2026-10-30"), 3);
});
