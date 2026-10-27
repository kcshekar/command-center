import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGroceries, formatHabits, formatVehicles, kmPerLitre, serviceStatus, streak, type Vehicle } from "./life-reports.js";

test("R11: streak counts through yesterday; nudge only for unlogged; Sunday adds the week", () => {
  assert.equal(streak(["2026-10-25", "2026-10-26"], "2026-10-27"), 2); // not done tonight yet → still alive
  assert.equal(streak(["2026-10-25", "2026-10-26", "2026-10-27"], "2026-10-27"), 3);
  assert.equal(streak(["2026-10-24"], "2026-10-27"), 0);
  const habits = [
    { name: "Walk", done: ["2026-10-21", "2026-10-22", "2026-10-24", "2026-10-25"] },
    { name: "Read", done: ["2026-10-25"] },
  ];
  assert.equal(formatHabits(habits, "2026-10-25", false), null); // all logged on a weekday
  assert.equal(formatHabits(habits, "2026-10-26", false), "*Not logged yet today:* Walk, Read");
  const sunday = formatHabits(habits, "2026-10-25", true)!;
  assert.match(sunday, /• Walk — 4\/7 · 2-day streak/);
  assert.match(sunday, /• Read — 1\/7$/m);
  assert.equal(formatHabits([], "2026-10-25", true), null);
});

test("R7: groceries list or nothing", () => {
  assert.equal(formatGroceries([{ name: "atta 5kg" }, { name: "butter" }]), "*Grocery list* (2 items)\n• atta 5kg\n• butter");
  assert.equal(formatGroceries([]), null);
});

test("R9: km/L over full-tank pairs, service due by km or months, monthly fuel in week 1", () => {
  const v: Vehicle = {
    name: "Activa",
    serviceEveryKm: 3000,
    serviceEveryMonths: 6,
    logs: [
      { kind: "service", on: "2026-05-01", odometerKm: 10000, litres: null, amountCents: 120000, fullTank: true },
      { kind: "fuel", on: "2026-09-20", odometerKm: 12000, litres: 5, amountCents: 53000, fullTank: true },
      { kind: "fuel", on: "2026-09-28", odometerKm: 12250, litres: 5, amountCents: 53000, fullTank: true },   // 250 km / 5 L
      { kind: "fuel", on: "2026-09-29", odometerKm: 12260, litres: 1, amountCents: 10600, fullTank: false },  // partial → breaks pair
      { kind: "fuel", on: "2026-10-10", odometerKm: 12600, litres: 6, amountCents: 63600, fullTank: true },
    ],
  };
  assert.equal(kmPerLitre(v.logs, "2026-09-01", "2026-09-30"), 50);
  assert.equal(serviceStatus(v, "2026-10-27"), "🔧 *Activa* service due — in 400 km / in 5 days (last on 2026-05-01 at 10,000 km)");
  assert.match(serviceStatus(v, "2026-11-04")!, /3 days overdue/); // 1 May + 6 months = 1 Nov
  assert.equal(serviceStatus({ ...v, serviceEveryKm: 5000, serviceEveryMonths: 12 }, "2026-10-27"), null);
  const firstWeek = formatVehicles([v], "2026-10-05")!;
  assert.match(firstWeek, /⛽ \*Activa\* in September: ₹1,166 on 11\.0 L · 50\.0 km\/L/);
  assert.doesNotMatch(formatVehicles([v], "2026-10-27") ?? "", /⛽/);
});
