import { expect, test } from "bun:test";
import { desiredSchedules, scheduleOwner } from "./automation-schedules";

test("desiredSchedules: one per pinned account, placeholders filled", () => {
  const tpl = {
    workflowType: "inboxTriageWorkflow", cron: "*/15 * * * *", perAccount: true,
    args: { userEmail: "$email", digestRouteKey: "$digest", approvalRouteKey: "$approval", userId: "$userId" },
  };
  const d = desiredSchedules("a5.mail", "u1", tpl, [{ email: "Me@Gmail.com" }, { email: "work@co.in" }]);
  expect([...d.keys()]).toEqual(["a5.mail:u1:me@gmail.com", "a5.mail:u1:work@co.in"]);
  expect(d.get("a5.mail:u1:work@co.in")).toEqual({
    userEmail: "work@co.in", digestRouteKey: "automations.digest", approvalRouteKey: "automations.approval", userId: "u1",
  });
  expect(desiredSchedules("a5.mail", "u1", tpl, []).size).toBe(0);
  const z = desiredSchedules("a5.mail", "u1", { ...tpl, args: { userEmail: "$email", zone: "$zone" } },
    [{ email: "me@gmail.com" }, { email: "work@co.in", zone: "professional" }]);
  expect(z.get("a5.mail:u1:me@gmail.com")).toEqual({ userEmail: "me@gmail.com", zone: "personal" });
  expect(z.get("a5.mail:u1:work@co.in")).toEqual({ userEmail: "work@co.in", zone: "professional" });
});

test("desiredSchedules: per-user template ignores accounts; literals untouched", () => {
  const tpl = { workflowType: "jobsIngestWorkflow", cron: "0 9 * * *", args: { userId: "$userId", minScore: 4, note: "$notAVar" } };
  const d = desiredSchedules("a2.jobs", "u1", tpl, [{ email: "x@y.z" }]);
  expect([...d.entries()]).toEqual([["a2.jobs:u1", { userId: "u1", minScore: 4, note: "$notAVar" }]]);
});

test("scheduleOwner: system ids have no owner", () => {
  expect(scheduleOwner("price-watch-daily-poll")).toBeNull();
  expect(scheduleOwner("a5.mail:u1:me@gmail.com")).toBe("u1");
  expect(scheduleOwner("a2.jobs:u1")).toBe("u1");
});
