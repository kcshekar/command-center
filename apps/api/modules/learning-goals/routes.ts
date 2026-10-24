import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";

// A8.1 — per-user CRUD for learning_goals.
//
// source_kind drives which fetcher the worker uses in A8.2:
//   github_release — target = "owner/repo"
//   dev_to_tag     — target = tag string, no slash
//   rss            — target = full feed URL (http[s] only)
//
// Target validation is per-kind so the UI can nudge the user with the right
// placeholder without needing to repeat the rules.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = ["github_release", "dev_to_tag", "rss"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asBool(v: unknown, dflt = true): boolean {
  return typeof v === "boolean" ? v : dflt;
}
function asMetadata(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}
function asWeight(v: unknown, dflt = 3): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(1, Math.min(5, Math.round(n)));
}
function validateTarget(kind: SourceKind, target: string): void {
  if (kind === "github_release") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(target)) {
      throw new HttpError(400, "github_release target must be 'owner/repo'");
    }
  } else if (kind === "dev_to_tag") {
    if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(target)) {
      throw new HttpError(400, "dev_to_tag target must be a short tag slug");
    }
  } else if (kind === "rss") {
    try {
      const u = new URL(target);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      throw new HttpError(400, "rss target must be an http(s) URL");
    }
  }
}

export const learningGoalRoutes = {
  "/api/learning-goals": {
    GET: tenantRoute(async (req, ctx) => {
      const url = new URL(req.url);
      const kind = url.searchParams.get("kind");
      const enabled = url.searchParams.get("enabled");
      const rows = await ctx.tx`
        SELECT id,
               source_kind  AS "sourceKind",
               target, weight, enabled, note, metadata,
               created_at   AS "createdAt",
               updated_at   AS "updatedAt"
        FROM learning_goals
        WHERE (${kind}::text IS NULL OR source_kind = ${kind})
          AND (${enabled}::text IS NULL OR enabled = (${enabled} = 'true'))
        ORDER BY enabled DESC, weight DESC, created_at ASC
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const sourceKind = asString(body.sourceKind ?? body.source_kind);
      const target = asString(body.target);
      if (!sourceKind || !(SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
        throw new HttpError(400, `sourceKind must be one of: ${SOURCE_KINDS.join(", ")}`);
      }
      if (!target) throw new HttpError(400, "target is required");
      validateTarget(sourceKind as SourceKind, target);
      const weight = asWeight(body.weight);
      const enabled = asBool(body.enabled, true);
      const note = asString(body.note);
      const metadata = asMetadata(body.metadata);

      let row: Record<string, unknown>;
      try {
        [row] = await ctx.tx`
          INSERT INTO learning_goals
            (org_id, user_id, source_kind, target, weight, enabled, note, metadata)
          VALUES
            (${ctx.orgId}::uuid, ${ctx.userId}::uuid,
             ${sourceKind}, ${target}, ${weight}, ${enabled},
             ${note}, ${JSON.stringify(metadata)}::text::jsonb)
          RETURNING id, source_kind AS "sourceKind", target, weight, enabled, note, metadata,
                    created_at AS "createdAt", updated_at AS "updatedAt"
        `;
      } catch (err) {
        if (err instanceof Error && /learning_goals_user_id_source_kind_target_key/i.test(err.message)) {
          throw new HttpError(409, "you already have this goal");
        }
        throw err;
      }

      await writeAudit(ctx.tx, ctx, {
        action: "learning_goal:create",
        resourceType: "learning_goal",
        resourceId: String(row.id),
        metadata: { sourceKind, target, enabled },
      });

      return Response.json(row, { status: 201 });
    }),
  },

  "/api/learning-goals/:id": {
    GET: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const [row] = await ctx.tx`
        SELECT id, source_kind AS "sourceKind", target, weight, enabled, note, metadata,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM learning_goals WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "learning goal not found");
      return Response.json(row);
    }),

    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

      let changed = 0;

      if (hasKey("target") || hasKey("sourceKind") || hasKey("source_kind")) {
        // If either changes, both must be present + validated so target can't
        // drift to the wrong shape.
        const [existing] = await ctx.tx`SELECT source_kind FROM learning_goals WHERE id = ${id}::uuid`;
        if (!existing) throw new HttpError(404, "learning goal not found");
        const sourceKind = asString(body.sourceKind ?? body.source_kind) ?? String(existing.source_kind);
        if (!(SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
          throw new HttpError(400, `sourceKind must be one of: ${SOURCE_KINDS.join(", ")}`);
        }
        const target = hasKey("target") ? asString(body.target) : null;
        if (hasKey("target") && !target) throw new HttpError(400, "target cannot be empty");
        if (target) validateTarget(sourceKind as SourceKind, target);
        if (hasKey("sourceKind") || hasKey("source_kind")) {
          await ctx.tx`UPDATE learning_goals SET source_kind = ${sourceKind}, updated_at = now() WHERE id = ${id}::uuid`;
          changed++;
        }
        if (target) {
          await ctx.tx`UPDATE learning_goals SET target = ${target}, updated_at = now() WHERE id = ${id}::uuid`;
          changed++;
        }
      }
      if (hasKey("weight")) {
        await ctx.tx`UPDATE learning_goals SET weight = ${asWeight(body.weight)}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("enabled")) {
        await ctx.tx`UPDATE learning_goals SET enabled = ${asBool(body.enabled)}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("note")) {
        await ctx.tx`UPDATE learning_goals SET note = ${asString(body.note) ?? null}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("metadata")) {
        await ctx.tx`UPDATE learning_goals SET metadata = ${JSON.stringify(asMetadata(body.metadata))}::text::jsonb, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (changed === 0) {
        throw new HttpError(400, "no updatable fields: sourceKind | target | weight | enabled | note | metadata");
      }

      const [row] = await ctx.tx`
        SELECT id, source_kind AS "sourceKind", target, weight, enabled, note, metadata,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM learning_goals WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "learning goal not found");

      await writeAudit(ctx.tx, ctx, {
        action: "learning_goal:update",
        resourceType: "learning_goal",
        resourceId: id,
      });

      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const deleted = await ctx.tx`DELETE FROM learning_goals WHERE id = ${id}::uuid RETURNING id`;
      if (deleted.length === 0) throw new HttpError(404, "learning goal not found");
      await writeAudit(ctx.tx, ctx, {
        action: "learning_goal:delete",
        resourceType: "learning_goal",
        resourceId: id,
      });
      return new Response(null, { status: 204 });
    }),
  },
};
