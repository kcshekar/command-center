import { tenantRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";

function b64ToBuf(s: string): Buffer {
  return Buffer.from(s, "base64");
}
function bufToB64(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

export const workspaceRoutes = {
  "/api/workspaces": {
    // Both counts are returned regardless of caller (Secrets vs. Vault
    // share this one workspace picker) — each page just reads the count it
    // cares about.
    GET: tenantRoute(async (_req, ctx) => {
      return Response.json(await ctx.tx`
        SELECT w.id, w.name, w.created_at,
               count(DISTINCT p.id)::int AS project_count,
               count(DISTINCT v.id)::int AS vault_item_count
        FROM workspaces w
        LEFT JOIN projects p ON p.workspace_id = w.id
        LEFT JOIN vault_items v ON v.workspace_id = w.id
        WHERE w.user_id = ${ctx.userId}
        GROUP BY w.id
        ORDER BY w.created_at
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      const {
        name,
        kdfAlgorithm,
        kdfSalt,
        kdfIterations,
        kdfMemoryKib,
        wrappedKeyByPassword,
        wrapIvPassword,
        wrappedKeyByRecovery,
        wrapIvRecovery,
      } = await req.json();
      if (!name || !kdfSalt || !wrappedKeyByPassword || !wrapIvPassword || !wrappedKeyByRecovery || !wrapIvRecovery) {
        throw new HttpError(400, "missing fields");
      }
      const [row] = await ctx.tx`
        INSERT INTO workspaces (user_id, name, kdf_algorithm, kdf_salt, kdf_iterations, kdf_memory_kib, wrapped_key_by_password, wrap_iv_password, wrapped_key_by_recovery, wrap_iv_recovery)
        VALUES (${ctx.userId}, ${name}, ${kdfAlgorithm ?? "pbkdf2"}, ${b64ToBuf(kdfSalt)}, ${kdfIterations ?? 210000}, ${kdfMemoryKib ?? null}, ${b64ToBuf(wrappedKeyByPassword)}, ${b64ToBuf(wrapIvPassword)}, ${b64ToBuf(wrappedKeyByRecovery)}, ${b64ToBuf(wrapIvRecovery)})
        RETURNING id, name, created_at
      `;
      await writeAudit(ctx.tx, ctx, { action: "workspace:create", resourceType: "workspace", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },

  // Key material needed to attempt unlock (password path) or recovery (recovery-key
  // path) — both wrapped copies are returned; the client picks which to use.
  // RLS already ensures this 404s for anyone else's workspace (no explicit check
  // needed — a row simply doesn't exist from another user's tenant context).
  "/api/workspaces/:workspaceId": {
    GET: tenantRoute(async (req, ctx) => {
      const { workspaceId } = req.params;
      const [row] = await ctx.tx`
        SELECT id, name, kdf_algorithm, kdf_salt, kdf_iterations, kdf_memory_kib, wrapped_key_by_password, wrap_iv_password, wrapped_key_by_recovery, wrap_iv_recovery
        FROM workspaces WHERE id = ${workspaceId}
      `;
      if (!row) throw new HttpError(404, "not found");
      // Not rate-limited like secret/vault reveal: this returns the same
      // wrapped blob regardless of whether the caller's password guess is
      // right, so throttling it doesn't slow an offline brute force the way
      // it does for per-secret reveals — but it's still the closest analog
      // to those endpoints, so it gets the same audit trail.
      await writeAudit(ctx.tx, ctx, { action: "workspace:key_material_view", resourceType: "workspace", resourceId: workspaceId });
      return Response.json({
        id: row.id,
        name: row.name,
        kdfAlgorithm: row.kdf_algorithm,
        kdfSalt: bufToB64(row.kdf_salt),
        kdfIterations: row.kdf_iterations,
        kdfMemoryKib: row.kdf_memory_kib,
        wrappedKeyByPassword: bufToB64(row.wrapped_key_by_password),
        wrapIvPassword: bufToB64(row.wrap_iv_password),
        wrappedKeyByRecovery: bufToB64(row.wrapped_key_by_recovery),
        wrapIvRecovery: bufToB64(row.wrap_iv_recovery),
      });
    }),
    // Destructive reset — last resort when both password and recovery key
    // are lost. Requires the exact workspace name as confirmation,
    // server-side, not just a UI checkbox: a buggy or scripted client can't
    // skip it.
    DELETE: tenantRoute(async (req, ctx) => {
      const { workspaceId } = req.params;
      const { confirmName } = await req.json();
      const [workspace] = await ctx.tx`SELECT name FROM workspaces WHERE id = ${workspaceId}`;
      if (!workspace) throw new HttpError(404, "not found");
      if (confirmName !== workspace.name) {
        throw new HttpError(400, "confirmName must exactly match the workspace name");
      }
      await ctx.tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await writeAudit(ctx.tx, ctx, {
        action: "workspace:delete",
        resourceType: "workspace",
        resourceId: workspaceId,
        metadata: { name: workspace.name },
      });
      return new Response(null, { status: 204 });
    }),
  },

  // Changing the password and recovering via the recovery key both end here:
  // the client already has the workspace key in memory (however it got it),
  // derives a new password-wrapping, and this just persists it. The server
  // never needs to know or care which path got the client there.
  "/api/workspaces/:workspaceId/password": {
    PUT: tenantRoute(async (req, ctx) => {
      const { workspaceId } = req.params;
      const { kdfAlgorithm, kdfSalt, kdfIterations, kdfMemoryKib, wrappedKeyByPassword, wrapIvPassword } = await req.json();
      if (!kdfSalt || !wrappedKeyByPassword || !wrapIvPassword) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        UPDATE workspaces SET
          kdf_algorithm = ${kdfAlgorithm ?? "pbkdf2"}, kdf_salt = ${b64ToBuf(kdfSalt)}, kdf_iterations = ${kdfIterations ?? 210000},
          kdf_memory_kib = ${kdfMemoryKib ?? null},
          wrapped_key_by_password = ${b64ToBuf(wrappedKeyByPassword)}, wrap_iv_password = ${b64ToBuf(wrapIvPassword)}
        WHERE id = ${workspaceId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "workspace:password_change", resourceType: "workspace", resourceId: workspaceId });
      return Response.json({ ok: true });
    }),
  },
};
