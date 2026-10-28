import { ScheduleOverlapPolicy } from "@temporalio/client";
import { temporalClient } from "./temporal";

// P3: a user's automation grant owns its Temporal schedules. One schedule per
// (automation, user) — or per pinned Google account when the template is
// perAccount — with ids "<automationId>:<userId>[:<email>]". The grant toggle
// calls reconcileGrantSchedules(); org-wide sweeps (price poll, TTD, embedder,
// interview reminders, upgrader) stay "system" schedules in init-schedules.ts
// and have no ':' in their id.

export interface ScheduleTemplate {
  workflowType: string;
  cron: string;
  perAccount?: boolean;
  args: Record<string, unknown>;
}

export interface GrantAccount {
  email: string;
  zone?: "personal" | "professional";
}

/** Who may see/control a schedule: system ids → owner/admin; per-user ids → that user only. */
export function scheduleOwner(scheduleId: string): string | null {
  const parts = scheduleId.split(":");
  return parts.length >= 2 ? parts[1] : null;
}

function fill(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === "string" && v.startsWith("$") && v.slice(1) in vars) return vars[v.slice(1)];
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

/** Pure: the schedules a grant should have, keyed by schedule id → workflow input. */
export function desiredSchedules(
  automationId: string,
  userId: string,
  template: ScheduleTemplate,
  accounts: GrantAccount[],
  routes = { digest: "automations.digest", approval: "automations.approval" },
): Map<string, Record<string, unknown>> {
  const prefix = `${automationId}:${userId}`;
  const vars = { userId, ...routes };
  const out = new Map<string, Record<string, unknown>>();
  if (template.perAccount) {
    for (const a of accounts) {
      const accountVars = { ...vars, email: a.email, zone: a.zone ?? "personal" };
      out.set(`${prefix}:${a.email.toLowerCase()}`, fill(template.args, accountVars) as Record<string, unknown>);
    }
  } else {
    out.set(prefix, fill(template.args, vars) as Record<string, unknown>);
  }
  return out;
}

/**
 * Make Temporal match the grant: create missing schedules, update spec/args on
 * existing ones, pause/unpause per `enabled`, delete schedules for accounts
 * that were unpinned. Idempotent — safe to call on every toggle.
 */
export async function reconcileGrantSchedules(p: {
  automationId: string;
  userId: string;
  template: ScheduleTemplate;
  enabled: boolean;
  accounts: GrantAccount[];
}): Promise<string[]> {
  const client = await temporalClient();
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";
  const timezoneName = process.env.SCHEDULE_TIMEZONE ?? "Asia/Kolkata";
  const desired = desiredSchedules(p.automationId, p.userId, p.template, p.accounts, {
    digest: process.env.SLACK_ROUTE_DIGEST ?? "automations.digest",
    approval: process.env.SLACK_ROUTE_APPROVAL ?? "automations.approval",
  });

  const prefix = `${p.automationId}:${p.userId}`;
  const existing = new Set<string>();
  // ponytail: full schedule.list() scan per toggle — fine at tens of
  // schedules; use a visibility query on the id prefix if it gets slow.
  for await (const s of client.schedule.list()) {
    if (s.scheduleId === prefix || s.scheduleId.startsWith(`${prefix}:`)) existing.add(s.scheduleId);
  }

  const note = p.enabled ? "enabled via CC grant" : "disabled via CC grant";
  for (const [scheduleId, args] of desired) {
    const action = { type: "startWorkflow" as const, workflowType: p.template.workflowType, args: [args], taskQueue };
    const spec = { cronExpressions: [p.template.cron], timezone: timezoneName };
    if (!existing.has(scheduleId)) {
      await client.schedule.create({
        scheduleId,
        action,
        spec,
        policies: { catchupWindow: "1 hour", overlap: ScheduleOverlapPolicy.SKIP },
        state: { paused: !p.enabled, note },
      });
      continue;
    }
    const handle = client.schedule.getHandle(scheduleId);
    await handle.update((prev) => ({ ...prev, action, spec }));
    const { state } = await handle.describe();
    if (p.enabled && state.paused) await handle.unpause(note);
    if (!p.enabled && !state.paused) await handle.pause(note);
  }

  for (const scheduleId of existing) {
    if (!desired.has(scheduleId)) await client.schedule.getHandle(scheduleId).delete();
  }
  return [...desired.keys()];
}
