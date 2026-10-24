import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { requireRole } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { textArrayLiteral } from "../../core/pg-array";

// Phase 1.6 — prompts (org defaults) + user_prompt_overrides.
//
// Read model for the UI: a single LEFT JOIN merges each prompt with the
// session user's own override, so the UI knows which prompts the current user
// has customised without a second call.
//
// Writes:
//   /api/prompts            — owner/admin only (manages org defaults)
//   /api/prompts/:name/override — any user (manages their own override only)
//
// The worker calls /api/integrations/prompts/:name (service-token-gated, see
// integrations/routes.ts) to resolve the effective prompt for a target user.

const NAME_RE = /^[a-z][a-z0-9_.-]{1,63}$/i;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}
function asMetadata(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}
function asTemperature(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    throw new HttpError(400, "defaultTemperature must be between 0 and 2");
  }
  return Math.round(n * 100) / 100;
}

export const promptRoutes = {
  "/api/prompts": {
    GET: tenantRoute(async (_req, ctx) => {
      // LEFT JOIN uses the current session user's RLS GUCs on
      // user_prompt_overrides, so the override only matches that user's row.
      const rows = await ctx.tx`
        SELECT p.id,
               p.name,
               p.description,
               p.body               AS "defaultBody",
               p.variables,
               p.default_model      AS "defaultModel",
               p.default_temperature AS "defaultTemperature",
               p.metadata           AS "defaultMetadata",
               p.updated_at         AS "updatedAt",
               (o.id IS NOT NULL)   AS "hasOverride",
               o.body               AS "overrideBody",
               o.default_model      AS "overrideModel",
               o.default_temperature AS "overrideTemperature",
               o.metadata           AS "overrideMetadata",
               o.updated_at         AS "overrideUpdatedAt"
        FROM prompts p
        LEFT JOIN user_prompt_overrides o ON o.prompt_name = p.name
        ORDER BY p.name
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const name = asString(body.name);
      if (!name || !NAME_RE.test(name)) {
        throw new HttpError(400, "name must match [a-z][a-z0-9_.-]{1,63}");
      }
      const promptBody = asString(body.body);
      if (!promptBody) throw new HttpError(400, "body is required");
      const description = asString(body.description);
      const variables = asStringArray(body.variables);
      const defaultModel = asString(body.defaultModel ?? body.default_model);
      const defaultTemperature = asTemperature(body.defaultTemperature ?? body.default_temperature);
      const metadata = asMetadata(body.metadata);

      let row: Record<string, unknown>;
      try {
        [row] = await ctx.tx`
          INSERT INTO prompts
            (org_id, name, description, body, variables, default_model, default_temperature, metadata, created_by)
          VALUES
            (${ctx.orgId}::uuid, ${name}, ${description}, ${promptBody},
             ${textArrayLiteral(variables)}::text[],
             ${defaultModel}, ${defaultTemperature},
             ${JSON.stringify(metadata)}::text::jsonb,
             ${ctx.userId}::uuid)
          RETURNING id, name, description,
                    body                AS "defaultBody",
                    variables,
                    default_model       AS "defaultModel",
                    default_temperature AS "defaultTemperature",
                    metadata            AS "defaultMetadata",
                    updated_at          AS "updatedAt"
        `;
      } catch (err) {
        if (err instanceof Error && /prompts_org_id_name_key/i.test(err.message)) {
          throw new HttpError(409, `prompt '${name}' already exists in this org`);
        }
        throw err;
      }

      await writeAudit(ctx.tx, ctx, {
        action: "prompt:create",
        resourceType: "prompt",
        resourceId: String(row.id),
        metadata: { name },
      });

      return Response.json(row, { status: 201 });
    }),
  },

  "/api/prompts/:name": {
    GET: tenantRoute(async (req, ctx) => {
      const { name } = req.params;
      const [row] = await ctx.tx`
        SELECT p.id,
               p.name,
               p.description,
               p.body               AS "defaultBody",
               p.variables,
               p.default_model      AS "defaultModel",
               p.default_temperature AS "defaultTemperature",
               p.metadata           AS "defaultMetadata",
               p.updated_at         AS "updatedAt",
               (o.id IS NOT NULL)   AS "hasOverride",
               o.body               AS "overrideBody",
               o.default_model      AS "overrideModel",
               o.default_temperature AS "overrideTemperature",
               o.metadata           AS "overrideMetadata",
               o.updated_at         AS "overrideUpdatedAt"
        FROM prompts p
        LEFT JOIN user_prompt_overrides o ON o.prompt_name = p.name
        WHERE p.name = ${name}
      `;
      if (!row) throw new HttpError(404, "prompt not found");
      return Response.json(row);
    }),

    PATCH: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { name } = req.params;
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

      let changed = 0;

      if (hasKey("body")) {
        const next = asString(body.body);
        if (!next) throw new HttpError(400, "body cannot be cleared");
        await ctx.tx`UPDATE prompts SET body = ${next}, updated_at = now() WHERE name = ${name}`;
        changed++;
      }
      if (hasKey("description")) {
        const next = asString(body.description) ?? null;
        await ctx.tx`UPDATE prompts SET description = ${next}, updated_at = now() WHERE name = ${name}`;
        changed++;
      }
      if (hasKey("variables")) {
        const next = asStringArray(body.variables);
        await ctx.tx`UPDATE prompts SET variables = ${textArrayLiteral(next)}::text[], updated_at = now() WHERE name = ${name}`;
        changed++;
      }
      if (hasKey("defaultModel") || hasKey("default_model")) {
        const next = asString(body.defaultModel ?? body.default_model) ?? null;
        await ctx.tx`UPDATE prompts SET default_model = ${next}, updated_at = now() WHERE name = ${name}`;
        changed++;
      }
      if (hasKey("defaultTemperature") || hasKey("default_temperature")) {
        const next = asTemperature(body.defaultTemperature ?? body.default_temperature);
        await ctx.tx`UPDATE prompts SET default_temperature = ${next}, updated_at = now() WHERE name = ${name}`;
        changed++;
      }
      if (hasKey("metadata")) {
        const next = asMetadata(body.metadata);
        await ctx.tx`UPDATE prompts SET metadata = ${JSON.stringify(next)}::text::jsonb, updated_at = now() WHERE name = ${name}`;
        changed++;
      }
      if (changed === 0) {
        throw new HttpError(400, "no updatable fields: body | description | variables | defaultModel | defaultTemperature | metadata");
      }

      const [row] = await ctx.tx`
        SELECT id, name, description,
               body                AS "defaultBody",
               variables,
               default_model       AS "defaultModel",
               default_temperature AS "defaultTemperature",
               metadata            AS "defaultMetadata",
               updated_at          AS "updatedAt"
        FROM prompts WHERE name = ${name}
      `;
      if (!row) throw new HttpError(404, "prompt not found");

      await writeAudit(ctx.tx, ctx, {
        action: "prompt:update",
        resourceType: "prompt",
        resourceId: String(row.id),
        metadata: { name },
      });

      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { name } = req.params;
      // Overrides reference by name (no FK), so clean them up explicitly.
      await ctx.tx`DELETE FROM user_prompt_overrides WHERE prompt_name = ${name}`;
      const deleted = await ctx.tx`DELETE FROM prompts WHERE name = ${name} RETURNING id`;
      if (deleted.length === 0) throw new HttpError(404, "prompt not found");

      await writeAudit(ctx.tx, ctx, {
        action: "prompt:delete",
        resourceType: "prompt",
        resourceId: String(deleted[0].id),
        metadata: { name },
      });
      return new Response(null, { status: 204 });
    }),
  },

  "/api/prompts/:name/override": {
    // Upsert the session user's own override. Prompt must exist first.
    PUT: tenantRoute(async (req, ctx) => {
      const { name } = req.params;
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const text = asString(body.body);
      if (!text) throw new HttpError(400, "body is required");
      const defaultModel = asString(body.defaultModel ?? body.default_model);
      const defaultTemperature = asTemperature(body.defaultTemperature ?? body.default_temperature);
      const metadata = asMetadata(body.metadata);

      const [parent] = await ctx.tx`SELECT 1 FROM prompts WHERE name = ${name}`;
      if (!parent) throw new HttpError(404, "prompt not found");

      const [row] = await ctx.tx`
        INSERT INTO user_prompt_overrides
          (org_id, user_id, prompt_name, body, default_model, default_temperature, metadata, updated_at)
        VALUES
          (${ctx.orgId}::uuid, ${ctx.userId}::uuid, ${name},
           ${text}, ${defaultModel}, ${defaultTemperature},
           ${JSON.stringify(metadata)}::text::jsonb, now())
        ON CONFLICT (user_id, prompt_name) DO UPDATE SET
          body                = EXCLUDED.body,
          default_model       = EXCLUDED.default_model,
          default_temperature = EXCLUDED.default_temperature,
          metadata            = EXCLUDED.metadata,
          updated_at          = now()
        RETURNING id, prompt_name AS "promptName",
                  body,
                  default_model       AS "defaultModel",
                  default_temperature AS "defaultTemperature",
                  metadata,
                  updated_at          AS "updatedAt"
      `;

      await writeAudit(ctx.tx, ctx, {
        action: "prompt_override:upsert",
        resourceType: "prompt",
        metadata: { name, promptId: parent ? undefined : null },
      });

      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { name } = req.params;
      const deleted = await ctx.tx`
        DELETE FROM user_prompt_overrides WHERE prompt_name = ${name} RETURNING id
      `;
      if (deleted.length === 0) throw new HttpError(404, "no override to clear");

      await writeAudit(ctx.tx, ctx, {
        action: "prompt_override:delete",
        resourceType: "prompt",
        metadata: { name },
      });
      return new Response(null, { status: 204 });
    }),
  },
};
