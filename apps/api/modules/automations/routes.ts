import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { temporalClient } from "../../core/temporal";
import { log } from "../../core/log";

// Dashboard surface: lists Temporal schedules + state, exposes
// pause/unpause/trigger. Read model is kept cheap (one describe per
// schedule, no cross-queries into workflow history yet); add last-run
// status via a second workflow.describe() call per row if/when needed.

interface ScheduleRow {
  id: string;
  workflowType: string | null;
  taskQueue: string | null;
  cadence: string;
  paused: boolean;
  note: string | null;
  numActions: number;
  recentActions: Array<{ scheduleTime: string; actualTime: string; workflowId: string | null }>;
  nextRuns: string[];
  runningCount: number;
  createdAt: string | null;
  lastUpdatedAt: string | null;
}

// Describe() normalizes cronExpressions into calendars/intervals; this
// renders those back to a human string. Covers the shapes init-schedules.ts
// creates today ("30 7 * * *", "*/15 * * * *"); falls back to "custom" for
// anything exotic.
function formatCadence(spec: {
  intervals?: Array<{ every: number }>;
  calendars?: Array<{
    hour?: Array<{ start: number; end: number; step: number }>;
    minute?: Array<{ start: number; end: number; step: number }>;
  }>;
}): string {
  if (spec.intervals && spec.intervals.length > 0) {
    const every = spec.intervals[0].every;
    const secs = Math.round(every / 1000);
    if (secs % 3600 === 0) return `Every ${secs / 3600}h`;
    if (secs % 60 === 0) return `Every ${secs / 60}m`;
    return `Every ${secs}s`;
  }
  const cal = spec.calendars?.[0];
  if (cal) {
    const h = cal.hour?.[0];
    const m = cal.minute?.[0];
    const singleHour = h && h.start === h.end;
    const singleMinute = m && m.start === m.end;
    if (singleHour && singleMinute) {
      const hh = String(h.start).padStart(2, "0");
      const mm = String(m.start).padStart(2, "0");
      return `Daily at ${hh}:${mm}`;
    }
  }
  return "custom";
}

async function describeAll(): Promise<ScheduleRow[]> {
  const client = await temporalClient();
  const rows: ScheduleRow[] = [];
  for await (const summary of client.schedule.list()) {
    try {
      const handle = client.schedule.getHandle(summary.scheduleId);
      const d = await handle.describe();
      const action = d.action as { type?: string; workflowType?: string; taskQueue?: string } | undefined;
      rows.push({
        id: summary.scheduleId,
        workflowType: action?.workflowType ?? null,
        taskQueue: action?.taskQueue ?? null,
        cadence: formatCadence(d.spec as any),
        paused: d.state.paused,
        note: d.state.note ?? null,
        numActions: d.info.numActionsTaken ?? 0,
        recentActions: (d.info.recentActions ?? []).slice(0, 5).map((a) => ({
          scheduleTime: a.scheduledAt.toISOString(),
          actualTime: a.takenAt.toISOString(),
          workflowId: a.action?.workflow?.workflowId ?? null,
        })),
        nextRuns: (d.info.nextActionTimes ?? []).slice(0, 3).map((t) => t.toISOString()),
        runningCount: (d.info.runningActions ?? []).length,
        createdAt: d.info.createdAt?.toISOString() ?? null,
        lastUpdatedAt: d.info.lastUpdatedAt?.toISOString() ?? null,
      });
    } catch (err) {
      log.warn("schedule describe failed, skipping", {
        scheduleId: summary.scheduleId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

export const automationRoutes = {
  "/api/automations/catalog": {
    // Catalog is global config; any authenticated user may read. Left-joins
    // the current user's grants (RLS-scoped to their user_id+org_id by
    // withTenantTx) so the UI can show enabled state without a second call.
    GET: tenantRoute(async (_req, ctx) => {
      const rows = await ctx.tx`
        SELECT c.id,
               c.name,
               c.description,
               c.required_scopes  AS "requiredScopes",
               c.cadence_default  AS "cadenceDefault",
               c.chains_to        AS "chainsTo",
               c.default_enabled  AS "defaultEnabled",
               COALESCE(g.enabled, FALSE) AS enabled,
               g.schedule_override AS "scheduleOverride",
               g.updated_at        AS "grantUpdatedAt"
        FROM automation_catalog c
        LEFT JOIN automation_grants g ON g.automation_id = c.id
        ORDER BY c.id
      `;
      return Response.json(rows);
    }),
  },

  "/api/automations/catalog/:id/grant": {
    // Per-user toggle. Upserts a grant row for (user, automation) with the
    // requested enabled state. RLS keeps users from writing to each other's
    // rows: the INSERT's org_id/user_id must match the GUCs withTenantTx set.
    // 1.3 only honors `enabled`; config/scheduleOverride stay on the row
    // (defaults) and get their own PATCH shape in later phases.
    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") {
        throw new HttpError(400, "body must include enabled: boolean");
      }
      const enabled = body.enabled;

      const [cat] = await ctx.tx`
        SELECT id FROM automation_catalog WHERE id = ${id}
      `;
      if (!cat) throw new HttpError(404, `unknown automation: ${id}`);

      const [grant] = await ctx.tx`
        INSERT INTO automation_grants (org_id, user_id, automation_id, enabled, updated_at)
        VALUES (${ctx.orgId}::uuid, ${ctx.userId}::uuid, ${id}, ${enabled}, now())
        ON CONFLICT (user_id, automation_id) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              updated_at = now()
        RETURNING automation_id, enabled, schedule_override, updated_at
      `;

      // audit_log.resource_id is a uuid column (migration 0001), so the slug
      // goes into metadata; the (action, resource_type, metadata.automationId)
      // triple is still enough to find any grant change.
      await writeAudit(ctx.tx, ctx, {
        action: enabled ? "automation_grant:enable" : "automation_grant:disable",
        resourceType: "automation",
        metadata: { automationId: id },
      });

      return Response.json({
        automationId: grant.automation_id,
        enabled: grant.enabled,
        scheduleOverride: grant.schedule_override,
        grantUpdatedAt: grant.updated_at,
      });
    }),
  },

  "/api/automations/schedules": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      try {
        return Response.json(await describeAll());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new HttpError(502, `Temporal unreachable: ${msg.slice(0, 200)}`);
      }
    }),
  },

  "/api/automations/schedules/:scheduleId/pause": {
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { scheduleId } = req.params;
      const client = await temporalClient();
      await client.schedule.getHandle(scheduleId).pause("paused via CC dashboard");
      // audit_log.resource_id is uuid (migration 0001); schedule ids are
      // slugs, so they go into metadata.
      await writeAudit(ctx.tx, ctx, {
        action: "schedule:pause",
        resourceType: "schedule",
        metadata: { scheduleId },
      });
      return Response.json({ ok: true });
    }),
  },

  "/api/automations/schedules/:scheduleId/unpause": {
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { scheduleId } = req.params;
      const client = await temporalClient();
      await client.schedule.getHandle(scheduleId).unpause("unpaused via CC dashboard");
      await writeAudit(ctx.tx, ctx, {
        action: "schedule:unpause",
        resourceType: "schedule",
        metadata: { scheduleId },
      });
      return Response.json({ ok: true });
    }),
  },

  "/api/automations/schedules/:scheduleId/trigger": {
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { scheduleId } = req.params;
      const client = await temporalClient();
      await client.schedule.getHandle(scheduleId).trigger();
      await writeAudit(ctx.tx, ctx, {
        action: "schedule:trigger",
        resourceType: "schedule",
        metadata: { scheduleId },
      });
      return Response.json({ ok: true });
    }),
  },
};
