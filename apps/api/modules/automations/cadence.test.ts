import { expect, test } from "bun:test";
import { cronCadence, formatCadence } from "./cadence";

// Shapes copied from real describe() output for our schedules.
const r = (start: number, end = start, step = 1) => ({ start, end, step });
const allWeek = [{ start: "SUNDAY", end: "SATURDAY", step: 1 }];
const cal = (c: object) => ({ calendars: [{ dayOfMonth: [r(1, 31)], dayOfWeek: allWeek, ...c }] });

test("formatCadence renders every schedule shape init-schedules creates", () => {
  expect(formatCadence(cal({ minute: [r(0, 59, 15)], hour: [r(0, 23)] }))).toBe("Every 15 min");
  expect(formatCadence(cal({ minute: [r(2, 59, 15)], hour: [r(0, 23)] }))).toBe("Every 15 min from :02");
  expect(formatCadence(cal({ minute: [r(0)], hour: [r(0, 23)] }))).toBe("Hourly");
  expect(formatCadence(cal({ minute: [r(0)], hour: [r(0, 23, 6)] }))).toBe("Every 6h");
  expect(formatCadence(cal({ minute: [r(30)], hour: [r(7)] }))).toBe("Daily at 07:30");
  expect(formatCadence(cal({ minute: [r(0)], hour: [r(9), r(18)] }))).toBe("Daily at 09:00 & 18:00");
  expect(formatCadence(cal({
    minute: [r(0)], hour: [r(9)],
    dayOfWeek: [{ start: "MONDAY", end: "MONDAY", step: 1 }, { start: "THURSDAY", end: "THURSDAY", step: 1 }],
  }))).toBe("Mon, Thu at 09:00");
  expect(formatCadence(cal({ minute: [r(0)], hour: [r(10)], dayOfMonth: [r(1)] }))).toBe("Monthly on day 1 at 10:00");
  expect(formatCadence({ intervals: [{ every: 900_000 }] })).toBe("Every 15 min");
  expect(formatCadence({})).toBe("custom");
});

test("cronCadence agrees with formatCadence for the catalog's cron strings", () => {
  expect(cronCadence("*/15 * * * *")).toBe("Every 15 min");
  expect(cronCadence("2-59/15 * * * *")).toBe("Every 15 min from :02");
  expect(cronCadence("8-59/30 * * * *")).toBe("Every 30 min from :08");
  expect(cronCadence("23 * * * *")).toBe("Hourly at :23");
  expect(cronCadence("35 */6 * * *")).toBe("Every 6h");
  expect(cronCadence("0 * * * *")).toBe("Hourly");
  expect(cronCadence("0 */6 * * *")).toBe("Every 6h");
  expect(cronCadence("30 7 * * *")).toBe("Daily at 07:30");
  expect(cronCadence("cron:0 9,18 * * *")).toBe("Daily at 09:00 & 18:00");
  expect(cronCadence("0 9 * * 1,4")).toBe("Mon, Thu at 09:00");
  expect(cronCadence("0 10 1 * *")).toBe("Monthly on day 1 at 10:00");
  expect(cronCadence("event")).toBe("On event");
  expect(cronCadence("manual")).toBe("On demand");
  expect(cronCadence("@daily")).toBe("custom");
});
