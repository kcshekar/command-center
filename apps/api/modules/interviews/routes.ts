import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";

// A3/A4 — CRUD for interview_sessions + interview_rounds. User-driven; the
// A3.prep worker also writes sessions via a service-token integration path
// (in slice 2) when the user triggers "Prep" from /jobs.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_STATUSES = ["researching","applied","interviewing","offered","rejected","withdrawn"] as const;
const ROUND_KINDS      = ["phone_screen","technical","system_design","behavioral","onsite","bar_raiser","other"] as const;
const ROUND_OUTCOMES   = ["passed","failed","pending"] as const;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "invalid timestamp");
  return d.toISOString();
}
function asIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function asMetadata(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

export const interviewRoutes = {
  "/api/interview-sessions": {
    GET: tenantRoute(async (req, ctx) => {
      const url = new URL(req.url);
      const status = url.searchParams.get("status");
      const rows = await ctx.tx`
        SELECT s.id, s.company, s.role,
               s.source_job_lead_id AS "sourceJobLeadId",
               s.status, s.applied_at AS "appliedAt", s.decision_at AS "decisionAt",
               s.notes, s.metadata,
               s.created_at AS "createdAt", s.updated_at AS "updatedAt",
               (SELECT count(*)::int FROM interview_rounds r WHERE r.session_id = s.id) AS "roundCount"
        FROM interview_sessions s
        WHERE (${status}::text IS NULL OR s.status = ${status})
        ORDER BY s.updated_at DESC
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const company = asString(body.company);
      const role = asString(body.role);
      if (!company || !role) throw new HttpError(400, "company and role are required");
      const sourceJobLeadId = asString(body.sourceJobLeadId ?? body.source_job_lead_id);
      if (sourceJobLeadId && !UUID_RE.test(sourceJobLeadId)) {
        throw new HttpError(400, "sourceJobLeadId must be a uuid");
      }
      const status = asString(body.status) ?? "researching";
      if (!(SESSION_STATUSES as readonly string[]).includes(status)) {
        throw new HttpError(400, `status must be one of: ${SESSION_STATUSES.join(", ")}`);
      }
      const notes = asString(body.notes);
      const metadata = asMetadata(body.metadata);

      const [row] = await ctx.tx`
        INSERT INTO interview_sessions
          (org_id, user_id, company, role, source_job_lead_id, status, notes, metadata)
        VALUES
          (${ctx.orgId}::uuid, ${ctx.userId}::uuid,
           ${company}, ${role},
           ${sourceJobLeadId ? sourceJobLeadId : null}::uuid,
           ${status}, ${notes},
           ${JSON.stringify(metadata)}::text::jsonb)
        RETURNING id, company, role,
                  source_job_lead_id AS "sourceJobLeadId",
                  status, applied_at AS "appliedAt", decision_at AS "decisionAt",
                  notes, metadata,
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      await writeAudit(ctx.tx, ctx, {
        action: "interview_session:create",
        resourceType: "interview_session",
        resourceId: String(row.id),
        metadata: { company, role, status },
      });

      return Response.json({ ...row, roundCount: 0 }, { status: 201 });
    }),
  },

  "/api/interview-sessions/:id": {
    GET: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const [row] = await ctx.tx`
        SELECT id, company, role,
               source_job_lead_id AS "sourceJobLeadId",
               status, applied_at AS "appliedAt", decision_at AS "decisionAt",
               notes, metadata,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM interview_sessions WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "interview session not found");
      const rounds = await ctx.tx`
        SELECT id, kind, scheduled_at AS "scheduledAt", duration_min AS "durationMin",
               interviewer, notes, outcome, metadata,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM interview_rounds
        WHERE session_id = ${id}::uuid
        ORDER BY COALESCE(scheduled_at, created_at) ASC
      `;
      return Response.json({ ...row, rounds });
    }),

    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

      let changed = 0;
      if (hasKey("company")) {
        const v = asString(body.company);
        if (!v) throw new HttpError(400, "company cannot be cleared");
        await ctx.tx`UPDATE interview_sessions SET company = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("role")) {
        const v = asString(body.role);
        if (!v) throw new HttpError(400, "role cannot be cleared");
        await ctx.tx`UPDATE interview_sessions SET role = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("status")) {
        const v = asString(body.status) ?? "researching";
        if (!(SESSION_STATUSES as readonly string[]).includes(v)) {
          throw new HttpError(400, `status must be one of: ${SESSION_STATUSES.join(", ")}`);
        }
        await ctx.tx`UPDATE interview_sessions SET status = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("appliedAt") || hasKey("applied_at")) {
        const v = asIsoOrNull(body.appliedAt ?? body.applied_at);
        await ctx.tx`UPDATE interview_sessions SET applied_at = ${v}::timestamptz, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("decisionAt") || hasKey("decision_at")) {
        const v = asIsoOrNull(body.decisionAt ?? body.decision_at);
        await ctx.tx`UPDATE interview_sessions SET decision_at = ${v}::timestamptz, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("notes")) {
        const v = asString(body.notes) ?? null;
        await ctx.tx`UPDATE interview_sessions SET notes = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("metadata")) {
        const m = asMetadata(body.metadata);
        await ctx.tx`UPDATE interview_sessions SET metadata = metadata || ${JSON.stringify(m)}::text::jsonb, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (changed === 0) {
        throw new HttpError(400, "no updatable fields: company | role | status | appliedAt | decisionAt | notes | metadata");
      }

      const [row] = await ctx.tx`
        SELECT id, company, role, source_job_lead_id AS "sourceJobLeadId",
               status, applied_at AS "appliedAt", decision_at AS "decisionAt",
               notes, metadata, updated_at AS "updatedAt"
        FROM interview_sessions WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "interview session not found");
      await writeAudit(ctx.tx, ctx, {
        action: "interview_session:update",
        resourceType: "interview_session",
        resourceId: id,
      });
      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const deleted = await ctx.tx`DELETE FROM interview_sessions WHERE id = ${id}::uuid RETURNING id`;
      if (deleted.length === 0) throw new HttpError(404, "interview session not found");
      await writeAudit(ctx.tx, ctx, {
        action: "interview_session:delete", resourceType: "interview_session", resourceId: id,
      });
      return new Response(null, { status: 204 });
    }),
  },

  "/api/interview-rounds": {
    // Upcoming rounds across all of the user's sessions (Today page).
    // ?withinDays=N, default 7, capped at 60.
    GET: tenantRoute(async (req, ctx) => {
      const n = Number(new URL(req.url).searchParams.get("withinDays") ?? 7);
      const days = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 60) : 7;
      const rows = await ctx.tx`
        SELECT r.id, r.session_id AS "sessionId", r.kind,
               r.scheduled_at AS "scheduledAt", r.duration_min AS "durationMin",
               r.interviewer, s.company, s.role
        FROM interview_rounds r
        JOIN interview_sessions s ON s.id = r.session_id
        WHERE r.scheduled_at >= now()
          AND r.scheduled_at <  now() + (${days}::int * INTERVAL '1 day')
        ORDER BY r.scheduled_at
        LIMIT 50
      `;
      return Response.json(rows);
    }),
    POST: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const sessionId = asString(body.sessionId ?? body.session_id);
      if (!sessionId || !UUID_RE.test(sessionId)) throw new HttpError(400, "sessionId (uuid) is required");
      const kind = asString(body.kind);
      if (!kind || !(ROUND_KINDS as readonly string[]).includes(kind)) {
        throw new HttpError(400, `kind must be one of: ${ROUND_KINDS.join(", ")}`);
      }
      const scheduledAt = body.scheduledAt !== undefined || body.scheduled_at !== undefined
        ? asIsoOrNull(body.scheduledAt ?? body.scheduled_at) : null;
      const durationMin = asIntOrNull(body.durationMin ?? body.duration_min);
      const interviewer = asString(body.interviewer);
      const notes = asString(body.notes);
      const outcome = asString(body.outcome);
      if (outcome && !(ROUND_OUTCOMES as readonly string[]).includes(outcome)) {
        throw new HttpError(400, `outcome must be one of: ${ROUND_OUTCOMES.join(", ")}`);
      }
      const metadata = asMetadata(body.metadata);

      // Must belong to a session the current user owns — RLS on sessions
      // enforces this because the FK insert tx is in the same tenant scope.
      const [row] = await ctx.tx`
        INSERT INTO interview_rounds
          (org_id, user_id, session_id, kind, scheduled_at, duration_min,
           interviewer, notes, outcome, metadata)
        VALUES
          (${ctx.orgId}::uuid, ${ctx.userId}::uuid, ${sessionId}::uuid,
           ${kind}, ${scheduledAt}::timestamptz, ${durationMin},
           ${interviewer}, ${notes}, ${outcome},
           ${JSON.stringify(metadata)}::text::jsonb)
        RETURNING id, session_id AS "sessionId", kind,
                  scheduled_at AS "scheduledAt", duration_min AS "durationMin",
                  interviewer, notes, outcome, metadata,
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      await writeAudit(ctx.tx, ctx, {
        action: "interview_round:create",
        resourceType: "interview_round",
        resourceId: String(row.id),
        metadata: { sessionId, kind },
      });
      return Response.json(row, { status: 201 });
    }),
  },

  "/api/interview-rounds/:id": {
    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

      let changed = 0;
      if (hasKey("kind")) {
        const v = asString(body.kind);
        if (!v || !(ROUND_KINDS as readonly string[]).includes(v)) {
          throw new HttpError(400, `kind must be one of: ${ROUND_KINDS.join(", ")}`);
        }
        await ctx.tx`UPDATE interview_rounds SET kind = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("scheduledAt") || hasKey("scheduled_at")) {
        const v = asIsoOrNull(body.scheduledAt ?? body.scheduled_at);
        await ctx.tx`UPDATE interview_rounds SET scheduled_at = ${v}::timestamptz, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("durationMin") || hasKey("duration_min")) {
        const v = asIntOrNull(body.durationMin ?? body.duration_min);
        await ctx.tx`UPDATE interview_rounds SET duration_min = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("interviewer")) {
        const v = asString(body.interviewer) ?? null;
        await ctx.tx`UPDATE interview_rounds SET interviewer = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("notes")) {
        const v = asString(body.notes) ?? null;
        await ctx.tx`UPDATE interview_rounds SET notes = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("outcome")) {
        const v = asString(body.outcome);
        if (v && !(ROUND_OUTCOMES as readonly string[]).includes(v)) {
          throw new HttpError(400, `outcome must be one of: ${ROUND_OUTCOMES.join(", ")}`);
        }
        await ctx.tx`UPDATE interview_rounds SET outcome = ${v}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (changed === 0) throw new HttpError(400, "no updatable fields: kind | scheduledAt | durationMin | interviewer | notes | outcome");

      const [row] = await ctx.tx`
        SELECT id, session_id AS "sessionId", kind,
               scheduled_at AS "scheduledAt", duration_min AS "durationMin",
               interviewer, notes, outcome, metadata, updated_at AS "updatedAt"
        FROM interview_rounds WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "interview round not found");
      await writeAudit(ctx.tx, ctx, {
        action: "interview_round:update", resourceType: "interview_round", resourceId: id,
      });
      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const deleted = await ctx.tx`DELETE FROM interview_rounds WHERE id = ${id}::uuid RETURNING id`;
      if (deleted.length === 0) throw new HttpError(404, "interview round not found");
      await writeAudit(ctx.tx, ctx, {
        action: "interview_round:delete", resourceType: "interview_round", resourceId: id,
      });
      return new Response(null, { status: 204 });
    }),
  },
};
