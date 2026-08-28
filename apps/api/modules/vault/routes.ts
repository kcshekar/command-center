import { tenantRoute, rateLimited } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";

function b64ToBuf(s: string): Buffer {
  return Buffer.from(s, "base64");
}
function bufToB64(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

// No RBAC checks: RLS on vault_items already scopes every query to
// workspaces owned by the logged-in user. Someone else's item 404s, it
// doesn't 403 — there's nothing to share here.
export const vaultRoutes = {
  "/api/vault/items": {
    GET: tenantRoute(async (req, ctx) => {
      const workspaceId = new URL(req.url).searchParams.get("workspaceId");
      if (!workspaceId) throw new HttpError(400, "workspaceId required");
      return Response.json(
        await ctx.tx`SELECT id, label, url, updated_at FROM vault_items WHERE workspace_id = ${workspaceId} ORDER BY label`
      );
    }),
    POST: tenantRoute(async (req, ctx) => {
      const { workspaceId, label, url, ciphertext, iv, wrappedDek, wrapIv } = await req.json();
      if (!workspaceId || !label || !ciphertext || !iv || !wrappedDek || !wrapIv) {
        throw new HttpError(400, "missing fields");
      }
      const [row] = await ctx.tx`
        INSERT INTO vault_items (workspace_id, label, url, ciphertext, iv, wrapped_dek, wrap_iv)
        VALUES (${workspaceId}, ${label}, ${url ?? null}, ${b64ToBuf(ciphertext)}, ${b64ToBuf(iv)}, ${b64ToBuf(wrappedDek)}, ${b64ToBuf(wrapIv)})
        RETURNING id, label, url, created_at
      `;
      await writeAudit(ctx.tx, ctx, { action: "vault_item:create", resourceType: "vault_item", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },

  "/api/vault/items/:itemId": {
    // Same reasoning as secret reveal: a stolen session could otherwise
    // script a mass dump of every stored credential at wire speed.
    GET: rateLimited("vault-item-view", 200, 3600)(async (req, ctx) => {
      const { itemId } = req.params;
      const [row] = await ctx.tx`
        SELECT id, label, url, ciphertext, iv, wrapped_dek, wrap_iv, workspace_id, updated_at
        FROM vault_items WHERE id = ${itemId}
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "vault_item:view", resourceType: "vault_item", resourceId: itemId });
      return Response.json({
        id: row.id,
        label: row.label,
        url: row.url,
        workspaceId: row.workspace_id,
        ciphertext: bufToB64(row.ciphertext),
        iv: bufToB64(row.iv),
        wrappedDek: bufToB64(row.wrapped_dek),
        wrapIv: bufToB64(row.wrap_iv),
        updatedAt: row.updated_at,
      });
    }),
    PUT: tenantRoute(async (req, ctx) => {
      const { itemId } = req.params;
      const { label, url, ciphertext, iv, wrappedDek, wrapIv } = await req.json();
      if (!label || !ciphertext || !iv || !wrappedDek || !wrapIv) {
        throw new HttpError(400, "missing fields");
      }
      const [row] = await ctx.tx`
        UPDATE vault_items SET
          label = ${label}, url = ${url ?? null}, ciphertext = ${b64ToBuf(ciphertext)}, iv = ${b64ToBuf(iv)},
          wrapped_dek = ${b64ToBuf(wrappedDek)}, wrap_iv = ${b64ToBuf(wrapIv)}, updated_at = now()
        WHERE id = ${itemId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "vault_item:update", resourceType: "vault_item", resourceId: itemId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const { itemId } = req.params;
      const [row] = await ctx.tx`DELETE FROM vault_items WHERE id = ${itemId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "vault_item:delete", resourceType: "vault_item", resourceId: itemId });
      return new Response(null, { status: 204 });
    }),
  },

  "/api/vault/items/:itemId/copy-event": {
    POST: rateLimited("vault-item-copy", 200, 3600)(async (req, ctx) => {
      const { itemId } = req.params;
      const [row] = await ctx.tx`SELECT id FROM vault_items WHERE id = ${itemId}`;
      if (!row) throw new HttpError(404, "not found");
      const { field } = await req.json().catch(() => ({ field: undefined }));
      await writeAudit(ctx.tx, ctx, {
        action: "vault_item:copy",
        resourceType: "vault_item",
        resourceId: itemId,
        metadata: { field },
      });
      return new Response(null, { status: 204 });
    }),
  },
};
