import type { SQL } from "bun";
import type { AuthCtx } from "./db";
import { HttpError } from "./auth";

export function requireRole(ctx: AuthCtx, roles: AuthCtx["role"][]) {
  if (!roles.includes(ctx.role)) throw new HttpError(403, "forbidden");
}

// Owners/admins see everything in their org. Members/contractors (e.g. a
// part-time employee) need an explicit resource_grants row for this specific
// project/resource — that's how "only see their project space" is enforced.
export async function requireResourceAccess(
  tx: SQL,
  ctx: AuthCtx,
  resourceType: string,
  resourceId: string,
  scope: "read" | "write" = "read"
) {
  if (ctx.role === "owner" || ctx.role === "admin") return;

  const rows = await tx`
    SELECT scope FROM resource_grants
    WHERE user_id = ${ctx.userId} AND resource_type = ${resourceType} AND resource_id = ${resourceId}
  `;
  const grant = rows[0];
  if (!grant) throw new HttpError(403, "forbidden");
  if (scope === "write" && grant.scope === "read") throw new HttpError(403, "forbidden");
}

// Shared by every module with owner-created, org-scoped resources (secrets
// projects, vault items, ...): the creator always has access, org owners/
// admins see everything, anyone else needs an explicit resource_grants row.
export async function assertOwnerOrGrant(
  tx: SQL,
  ctx: AuthCtx,
  resourceType: string,
  resourceId: string,
  ownerId: string,
  scope: "read" | "write" = "read"
) {
  if (ctx.role === "owner" || ctx.role === "admin" || ownerId === ctx.userId) return;
  await requireResourceAccess(tx, ctx, resourceType, resourceId, scope);
}
