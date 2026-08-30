import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";

// Owner/admin only — this is the org's activity trail, not a per-user log.
// RLS (audit_select policy) already scopes rows to the caller's org; the
// role check on top of that is about who gets to SEE the trail, not whose
// data is in it.
export const auditRoutes = {
  "/api/audit-log": {
    GET: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const url = new URL(req.url);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const before = url.searchParams.get("before"); // audit_log.id cursor, exclusive

      const rows = before
        ? await ctx.tx`
            SELECT a.id, a.action, a.resource_type, a.resource_id, a.metadata, a.created_at, u.email AS actor_email
            FROM audit_log a JOIN users u ON u.id = a.actor_id
            WHERE a.id < ${before}
            ORDER BY a.id DESC LIMIT ${limit}
          `
        : await ctx.tx`
            SELECT a.id, a.action, a.resource_type, a.resource_id, a.metadata, a.created_at, u.email AS actor_email
            FROM audit_log a JOIN users u ON u.id = a.actor_id
            ORDER BY a.id DESC LIMIT ${limit}
          `;
      return Response.json(rows);
    }),
  },
};
