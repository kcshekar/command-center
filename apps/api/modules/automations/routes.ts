import { tenantRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { temporalClient } from "../../core/temporal";
import { log } from "../../core/log";
import { cronCadence, formatCadence } from "./cadence";
import { reconcileGrantSchedules, scheduleOwner, type GrantAccount, type ScheduleTemplate } from "../../core/automation-schedules";
import type { AuthCtx } from "../../core/auth";

// Per-user schedules ("<automation>:<userId>[:<email>]") belong to that user;
// system schedules (no ':') are org-wide sweeps, owner/admin only.
function canSeeSchedule(ctx: Pick<AuthCtx, "userId" | "role">, scheduleId: string): boolean {
  const owner = scheduleOwner(scheduleId);
  return owner === null ? ctx.role === "owner" || ctx.role === "admin" : owner === ctx.userId;
}
function assertScheduleAccess(ctx: Pick<AuthCtx, "userId" | "role">, scheduleId: string) {
  if (!canSeeSchedule(ctx, scheduleId)) throw new HttpError(403, "not your schedule");
}

// Google accounts the current user may pin: connected through the signed
// flow for this user (metadata.ccUserId), or legacy rows in their org that
// predate it (no ccUserId yet — reconnecting stamps them).
async function pinnableGoogleAccounts(ctx: { tx: any; userId: string }): Promise<string[]> {
  const rows = await ctx.tx`
    SELECT user_id AS email FROM external_accounts
    WHERE service = 'google' AND status = 'active'
      AND (metadata->>'ccUserId' IS NULL OR metadata->>'ccUserId' = ${ctx.userId})
    ORDER BY user_id
  `;
  return rows.map((r: { email: string }) => r.email);
}

// Dashboard surface: lists Temporal schedules + state, exposes
// pause/unpause/trigger. Two describes per schedule: the schedule, plus the
// most recent run's workflow for lastRunStatus.
// ponytail: 2×N parallel describes per request — fine at ~15 schedules;
// switch to one workflow.list() visibility query if this grows to dozens.

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
  // Temporal status of the most recent run: COMPLETED | FAILED | TIMED_OUT |
  // TERMINATED | CANCELED | RUNNING | … ; null when it never ran or history
  // is gone (retention).
  lastRunStatus: string | null;
  createdAt: string | null;
  lastUpdatedAt: string | null;
}

async function describeOne(client: Awaited<ReturnType<typeof temporalClient>>, scheduleId: string): Promise<ScheduleRow | null> {
  try {
    const handle = client.schedule.getHandle(scheduleId);
    const d = await handle.describe();
    const action = d.action as { type?: string; workflowType?: string; taskQueue?: string } | undefined;
    const latest = [...(d.info.recentActions ?? [])].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())[0];
    const latestId = latest?.action?.workflow?.workflowId;
    let lastRunStatus: string | null = null;
    if (latestId) {
      lastRunStatus = await client.workflow.getHandle(latestId).describe()
        .then((w) => w.status.name)
        .catch(() => null); // aged out of retention
    }
    return {
      id: scheduleId,
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
      lastRunStatus,
      createdAt: d.info.createdAt?.toISOString() ?? null,
      lastUpdatedAt: d.info.lastUpdatedAt?.toISOString() ?? null,
    };
  } catch (err) {
    log.warn("schedule describe failed, skipping", {
      scheduleId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function describeAll(): Promise<ScheduleRow[]> {
  const client = await temporalClient();
  const ids: string[] = [];
  for await (const summary of client.schedule.list()) ids.push(summary.scheduleId);
  // Describes run in parallel — sequential round trips to the Temporal
  // server made the Today page wait on N×2 latencies.
  const described = await Promise.all(ids.map((scheduleId) => describeOne(client, scheduleId)));
  const rows = described.filter((r): r is ScheduleRow => r !== null);
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
               c.area,
               c.ui_route         AS "uiRoute",
               c.ui_label         AS "uiLabel",
               c.icon,
               COALESCE(g.enabled, FALSE) AS enabled,
               g.schedule_override AS "scheduleOverride",
               COALESCE(g.config, '{}'::jsonb) AS config,
               c.schedule_template IS NOT NULL AS "hasSchedule",
               COALESCE((c.schedule_template->>'perAccount')::boolean, false) AS "perAccount",
               COALESCE(c.schedule_template->'args' ? 'zone', false) AS "usesZone",
               COALESCE(c.schedule_template->>'cron', c.cadence_default) AS "cadenceExpr",
               g.updated_at        AS "grantUpdatedAt"
        FROM automation_catalog c
        LEFT JOIN automation_grants g ON g.automation_id = c.id
        ORDER BY c.id
      `;
      return Response.json(rows.map(({ cadenceExpr, ...r }: Record<string, unknown>) => ({
        ...r,
        cadence: cronCadence(cadenceExpr as string | null),
      })));
    }),
  },

  "/api/automations/catalog/:id/grant": {
    // Per-user toggle. Upserts a grant row for (user, automation) with the
    // requested enabled state. RLS keeps users from writing to each other's
    // rows: the INSERT's org_id/user_id must match the GUCs withTenantTx set.
    // 1.3 only honors `enabled`; config/scheduleOverride stay on the row
    // (defaults) and get their own PATCH shape in later phases.
    PATCH: tenantRoute(async (req, ctx) => {
      // Body: { enabled?: boolean, accounts?: [{ email, zone? }] }. Saves the
      // grant, then makes Temporal match it (create / update / pause /
      // delete the user's schedules). A Temporal failure throws, which rolls
      // back the grant row so DB and Temporal don't drift.
      const { id } = req.params;
      const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; accounts?: unknown };
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        throw new HttpError(400, "enabled must be a boolean");
      }

      const [cat] = await ctx.tx`
        SELECT id, schedule_template FROM automation_catalog WHERE id = ${id}
      `;
      if (!cat) throw new HttpError(404, `unknown automation: ${id}`);
      const template = cat.schedule_template as ScheduleTemplate | null;

      const [prev] = await ctx.tx`
        SELECT enabled, config FROM automation_grants WHERE user_id = ${ctx.userId}::uuid AND automation_id = ${id}
      `;
      const enabled = typeof body.enabled === "boolean" ? body.enabled : Boolean(prev?.enabled);
      const config = { ...((prev?.config as Record<string, unknown>) ?? {}) };

      const pinnable = await pinnableGoogleAccounts(ctx);
      if (body.accounts !== undefined) {
        if (!Array.isArray(body.accounts)) throw new HttpError(400, "accounts must be an array");
        const accounts: GrantAccount[] = [];
        for (const a of body.accounts as Array<{ email?: unknown; zone?: unknown }>) {
          const given = typeof a?.email === "string" ? a.email.trim().toLowerCase() : "";
          // Keep the stored spelling: worker credentials are keyed by it.
          const email = pinnable.find((p) => p.toLowerCase() === given);
          if (!email) throw new HttpError(400, `${given || "account"} is not a Google account connected for you`);
          if (a.zone !== undefined && a.zone !== "personal" && a.zone !== "professional") {
            throw new HttpError(400, "zone must be personal | professional");
          }
          accounts.push(a.zone ? { email, zone: a.zone } : { email });
        }
        config.accounts = accounts;
      }
      // First enable of an account-based automation with nothing pinned:
      // pin every connected Google account (user can unpin in Settings).
      if (template?.perAccount && enabled && !Array.isArray(config.accounts)) {
        if (pinnable.length === 0) throw new HttpError(400, "Connect a Google account in the Control room first");
        config.accounts = pinnable.map((email) => ({ email }));
      }
      if (template?.perAccount && enabled && (config.accounts as GrantAccount[]).length === 0) {
        throw new HttpError(400, "Pin at least one Google account before turning this on");
      }

      const [grant] = await ctx.tx`
        INSERT INTO automation_grants (org_id, user_id, automation_id, enabled, config, updated_at)
        VALUES (${ctx.orgId}::uuid, ${ctx.userId}::uuid, ${id}, ${enabled}, ${JSON.stringify(config)}::text::jsonb, now())
        ON CONFLICT (user_id, automation_id) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              config = EXCLUDED.config,
              updated_at = now()
        RETURNING automation_id, enabled, config, schedule_override, updated_at
      `;

      let scheduleIds: string[] = [];
      if (template) {
        try {
          scheduleIds = await reconcileGrantSchedules({
            automationId: id, userId: ctx.userId, template, enabled,
            accounts: (config.accounts as GrantAccount[] | undefined) ?? [],
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new HttpError(502, `Could not update the schedule in Temporal: ${msg.slice(0, 200)}`);
        }
      }

      // audit_log.resource_id is a uuid column (migration 0001), so the slug
      // goes into metadata; the (action, resource_type, metadata.automationId)
      // triple is still enough to find any grant change.
      await writeAudit(ctx.tx, ctx, {
        action: enabled ? "automation_grant:enable" : "automation_grant:disable",
        resourceType: "automation",
        metadata: { automationId: id, scheduleIds },
      });

      return Response.json({
        automationId: grant.automation_id,
        enabled: grant.enabled,
        config: grant.config,
        scheduleOverride: grant.schedule_override,
        grantUpdatedAt: grant.updated_at,
        scheduleIds,
      });
    }),
  },

  // Recent runs of the current user's own schedules, newest first. Optional
  // ?automationId= narrows to one automation. Uses Temporal visibility
  // (TemporalScheduledById); exact-id OR, since STARTS_WITH isn't reliable on
  // this server. Manual "Run now" goes through the schedule, so it shows too.
  "/api/automations/runs": {
    GET: tenantRoute(async (req, ctx) => {
      const url = new URL(req.url);
      const automationId = url.searchParams.get("automationId");
      const n = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 300) : 50;
      const client = await temporalClient();
      const prefix = automationId ? `${automationId}:${ctx.userId}` : null;
      const ids: string[] = [];
      for await (const sch of client.schedule.list()) {
        const id = sch.scheduleId;
        if (scheduleOwner(id) !== ctx.userId) continue;
        if (prefix && id !== prefix && !id.startsWith(`${prefix}:`)) continue;
        ids.push(id);
      }
      if (ids.length === 0) return Response.json([]);
      // ponytail: one OR query across all of the user's schedules — fine at
      // dozens; page by automation if the query string ever gets too long.
      const query = ids.map((id) => `TemporalScheduledById = '${id.replace(/'/g, "")}'`).join(" OR ");
      const runs: Array<Record<string, unknown>> = [];
      for await (const w of client.workflow.list({ query })) {
        runs.push({
          workflowId: w.workflowId,
          scheduleId: ids.find((id) => w.workflowId.startsWith(`${id}-workflow-`)) ?? null,
          workflowType: w.type,
          status: w.status.name,
          startTime: w.startTime.toISOString(),
          closeTime: w.closeTime?.toISOString() ?? null,
        });
        if (runs.length >= limit) break;
      }
      return Response.json(runs);
    }),
  },

  "/api/automations/google-accounts": {
    GET: tenantRoute(async (_req, ctx) => Response.json(await pinnableGoogleAccounts(ctx))),
  },

  "/api/automations/schedules": {
    GET: tenantRoute(async (_req, ctx) => {
      try {
        return Response.json((await describeAll()).filter((r) => canSeeSchedule(ctx, r.id)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new HttpError(502, `Temporal unreachable: ${msg.slice(0, 200)}`);
      }
    }),
  },

  "/api/automations/schedules/:scheduleId/pause": {
    POST: tenantRoute(async (req, ctx) => {
      const { scheduleId } = req.params;
      assertScheduleAccess(ctx, scheduleId);
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
      const { scheduleId } = req.params;
      assertScheduleAccess(ctx, scheduleId);
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
      const { scheduleId } = req.params;
      assertScheduleAccess(ctx, scheduleId);
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
