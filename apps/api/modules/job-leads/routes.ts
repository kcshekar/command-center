import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";
import { temporalClient } from "../../core/temporal";
import { log } from "../../core/log";

const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";

// A2.1 — user-facing CRUD for job_leads. Workers write via a service-token
// integration endpoint (lands in A2.2). Users mostly read + change status.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["new", "saved", "applied", "skipped", "interview", "rejected"] as const;

export const jobLeadRoutes = {
  "/api/job-leads": {
    GET: tenantRoute(async (req, ctx) => {
      const url = new URL(req.url);
      const status = url.searchParams.get("status");
      const minScore = url.searchParams.get("minScore");
      const source = url.searchParams.get("source");
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100)));

      const rows = await ctx.tx`
        SELECT id, source, source_id AS "sourceId",
               title, company, location, url,
               salary_min    AS "salaryMin",
               salary_max    AS "salaryMax",
               currency, salary_period AS "salaryPeriod",
               description,
               posted_at     AS "postedAt",
               fetched_at    AS "fetchedAt",
               score, score_reason AS "scoreReason",
               classified_at AS "classifiedAt",
               status, metadata,
               created_at    AS "createdAt",
               updated_at    AS "updatedAt"
        FROM job_leads
        WHERE (${status}::text IS NULL OR status = ${status})
          AND (${source}::text IS NULL OR source = ${source})
          AND (${minScore}::text IS NULL OR score >= (${minScore})::int)
        ORDER BY COALESCE(score, 0) DESC, fetched_at DESC
        LIMIT ${limit}
      `;
      return Response.json(rows);
    }),
  },

  "/api/job-leads/:id": {
    GET: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const [row] = await ctx.tx`
        SELECT id, source, source_id AS "sourceId",
               title, company, location, url,
               salary_min    AS "salaryMin",
               salary_max    AS "salaryMax",
               currency, salary_period AS "salaryPeriod",
               description,
               posted_at     AS "postedAt",
               fetched_at    AS "fetchedAt",
               score, score_reason AS "scoreReason",
               classified_at AS "classifiedAt",
               status, metadata,
               created_at    AS "createdAt",
               updated_at    AS "updatedAt"
        FROM job_leads WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "job lead not found");
      return Response.json(row);
    }),

    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

      // Users only mutate status + metadata via this endpoint. Score/title/etc
      // belong to the fetcher/classifier integration path (A2.2 + A2.3).
      let changed = 0;
      if (hasKey("status")) {
        const next = typeof body.status === "string" ? body.status : "";
        if (!(STATUSES as readonly string[]).includes(next)) {
          throw new HttpError(400, `status must be one of: ${STATUSES.join(", ")}`);
        }
        await ctx.tx`UPDATE job_leads SET status = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("metadata")) {
        const m = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata as Record<string, unknown> : {};
        await ctx.tx`UPDATE job_leads SET metadata = metadata || ${JSON.stringify(m)}::text::jsonb, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (changed === 0) throw new HttpError(400, "no updatable fields: status | metadata");

      const [row] = await ctx.tx`
        SELECT id, status, metadata, updated_at AS "updatedAt"
        FROM job_leads WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "job lead not found");

      await writeAudit(ctx.tx, ctx, {
        action: "job_lead:update",
        resourceType: "job_lead",
        resourceId: id,
        metadata: { newStatus: body.status },
      });

      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const deleted = await ctx.tx`DELETE FROM job_leads WHERE id = ${id}::uuid RETURNING id`;
      if (deleted.length === 0) throw new HttpError(404, "job lead not found");
      await writeAudit(ctx.tx, ctx, {
        action: "job_lead:delete",
        resourceType: "job_lead",
        resourceId: id,
      });
      return new Response(null, { status: 204 });
    }),
  },

  // A9.resume — kick off the resume-tailor workflow for a job lead.
  "/api/job-leads/:id/tailor": {
    POST: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const [row] = await ctx.tx`
        SELECT jl.id, jl.title, jl.company, u.email
        FROM job_leads jl
        JOIN users u ON u.id = jl.user_id
        WHERE jl.id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "job lead not found");

      const workflowId = `resume-tailor-${id}-${Date.now()}`;
      try {
        const client = await temporalClient();
        await client.workflow.start("resumeTailorWorkflow", {
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId,
          args: [{ userId: ctx.userId, userEmail: row.email, jobLeadId: id }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("resume tailor workflow start failed", { jobLeadId: id, err: msg });
        throw new HttpError(502, `Temporal: ${msg.slice(0, 160)}`);
      }

      await writeAudit(ctx.tx, ctx, {
        action: "job_lead:tailor_requested",
        resourceType: "job_lead",
        resourceId: id,
        metadata: { workflowId, title: row.title, company: row.company },
      });

      return Response.json({ ok: true, workflowId });
    }),
  },

  // A3.prep — kick off the interview-prep workflow for a job lead. Returns
  // immediately with the Temporal workflow id so the UI can show "started".
  // The worker creates the knowledge_item + interview_session over the
  // integration path within ~30-90s.
  "/api/job-leads/:id/prep": {
    POST: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const [row] = await ctx.tx`
        SELECT id, title, company FROM job_leads WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "job lead not found");

      const workflowId = `interview-prep-${id}`;
      try {
        const client = await temporalClient();
        await client.workflow.start("interviewPrepWorkflow", {
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId,
          args: [{ userId: ctx.userId, jobLeadId: id }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Already-started = idempotent — treat as success (user clicked twice).
        if (!/already (started|exists)/i.test(msg)) {
          log.warn("interview prep workflow start failed", { jobLeadId: id, err: msg });
          throw new HttpError(502, `Temporal: ${msg.slice(0, 160)}`);
        }
      }

      await writeAudit(ctx.tx, ctx, {
        action: "job_lead:prep_requested",
        resourceType: "job_lead",
        resourceId: id,
        metadata: { workflowId, title: row.title, company: row.company },
      });

      return Response.json({ ok: true, workflowId });
    }),
  },
};
