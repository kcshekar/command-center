import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { generateServiceToken } from "../../core/service-token";
import { textArrayLiteral } from "../../core/pg-array";

const ALLOWED_SCOPES = new Set(["expenses:write", "reminders:write", "reminders:read", "slack:send"]);

export const serviceTokenRoutes = {
  "/api/service-tokens": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const rows = await ctx.tx`
        SELECT id, name, token_prefix, scopes, acting_user_id, expires_at,
               last_used_at, created_by, created_at
        FROM service_tokens WHERE org_id = ${ctx.orgId}
        ORDER BY created_at DESC
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { name, scopes, expiresAt } = await req.json();
      if (!name?.trim()) throw new HttpError(400, "name is required");
      if (!Array.isArray(scopes) || scopes.length === 0) throw new HttpError(400, "at least one scope is required");
      const bad = scopes.filter((s: string) => !ALLOWED_SCOPES.has(s));
      if (bad.length) throw new HttpError(400, `unknown scope(s): ${bad.join(", ")}`);

      const { raw, hash, prefix } = generateServiceToken();
      const [row] = await ctx.tx`
        INSERT INTO service_tokens (org_id, name, token_hash, token_prefix, scopes, acting_user_id, expires_at, created_by)
        VALUES (${ctx.orgId}, ${name.trim()}, ${hash}, ${prefix}, ${textArrayLiteral(scopes)}::text[], ${ctx.userId}, ${expiresAt ?? null}, ${ctx.userId})
        RETURNING id, name, token_prefix, scopes, expires_at, created_at
      `;
      await writeAudit(ctx.tx, ctx, { action: "service_token:create", resourceType: "service_token", resourceId: row.id });
      // raw token returned exactly once — never persisted, never fetchable again
      return Response.json({ ...row, token: raw }, { status: 201 });
    }),
  },

  "/api/service-tokens/:tokenId": {
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { tokenId } = req.params;
      const [deleted] = await ctx.tx`DELETE FROM service_tokens WHERE id = ${tokenId} AND org_id = ${ctx.orgId} RETURNING id`;
      if (!deleted) throw new HttpError(404, "token not found");
      await writeAudit(ctx.tx, ctx, { action: "service_token:revoke", resourceType: "service_token", resourceId: tokenId });
      return new Response(null, { status: 204 });
    }),
  },
};
