import { test } from "node:test";
import assert from "node:assert/strict";
import { dueOccasions, formatOccasions, type Occasion } from "./occasions.js";

const o = (person: string, month: number, day: number, extra: Partial<Occasion> = {}): Occasion =>
  ({ person, relationship: null, kind: "birthday", month, day, year: null, notes: null, ...extra });

test("R3: only 7 days out or today; age; leap day; formatting with and without extras", () => {
  const today = "2026-10-27";
  const due = dueOccasions([
    o("Asha", 11, 3, { year: 1996, relationship: "sister" }), // 7 days → heads-up, turning 30
    o("Ravi & Meena", 10, 27, { kind: "anniversary", year: 2016 }), // today, 10 years
    o("Kiran", 11, 4),                                          // 8 days → quiet
    o("Leap", 2, 29),                                           // far away → quiet
  ], today);
  assert.deepEqual(due.map((x) => [x.o.person, x.daysLeft, x.turning]), [["Ravi & Meena", 0, 10], ["Asha", 7, 30]]);

  const text = formatOccasions(due, new Map([
    ["Ravi & Meenaanniversary", { draft: "Happy anniversary!" }],
    ["Ashabirthday", { ideas: ["A Kindle", "Pottery class"] }],
  ]))!;
  assert.match(text, /🎉 \*Today: Ravi & Meena — anniversary \(10 years\)\*\nDraft message: _Happy anniversary!_/);
  assert.match(text, /\*In a week \(Tue, 3 Nov\): Asha's birthday \(turning 30\)\*\n• A Kindle\n• Pottery class/);
  // Model unavailable → the reminder still goes out.
  assert.match(formatOccasions(due, new Map())!, /In a week .*Asha's birthday/);
  assert.equal(formatOccasions([], new Map()), null);

  // Feb 29 lands on Feb 28 in a non-leap year.
  assert.equal(dueOccasions([o("Leap", 2, 29)], "2027-02-21")[0].on, "2027-02-28");
});
