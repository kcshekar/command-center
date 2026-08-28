import { tenantRoute, rateLimited } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";

function b64ToBuf(s: string): Buffer {
  return Buffer.from(s, "base64");
}
function bufToB64(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

// No RBAC checks anywhere in this module: RLS on projects/environments/secrets
// already scopes every query to workspaces owned by the logged-in user (see
// 0002_secrets.sql). A project belonging to someone else's workspace simply
// doesn't exist as far as any query here is concerned — 404, not 403.
export const secretsRoutes = {
  "/api/secrets/projects": {
    GET: tenantRoute(async (req, ctx) => {
      const workspaceId = new URL(req.url).searchParams.get("workspaceId");
      if (!workspaceId) throw new HttpError(400, "workspaceId required");
      return Response.json(
        await ctx.tx`SELECT id, name, created_at FROM projects WHERE workspace_id = ${workspaceId} ORDER BY created_at`
      );
    }),
    POST: tenantRoute(async (req, ctx) => {
      const { workspaceId, name, wrappedDek, wrapIv } = await req.json();
      if (!workspaceId || !name || !wrappedDek || !wrapIv) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO projects (workspace_id, name, wrapped_dek, wrap_iv, created_by)
        VALUES (${workspaceId}, ${name}, ${b64ToBuf(wrappedDek)}, ${b64ToBuf(wrapIv)}, ${ctx.userId})
        RETURNING id, name, created_at
      `;
      await writeAudit(ctx.tx, ctx, { action: "project:create", resourceType: "project", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },

  "/api/secrets/projects/:projectId": {
    GET: tenantRoute(async (req, ctx) => {
      const { projectId } = req.params;
      const [project] = await ctx.tx`
        SELECT id, name, workspace_id, wrapped_dek, wrap_iv, created_at FROM projects WHERE id = ${projectId}
      `;
      if (!project) throw new HttpError(404, "not found");
      const environments = await ctx.tx`SELECT id, name FROM environments WHERE project_id = ${projectId} ORDER BY name`;
      return Response.json({
        id: project.id,
        name: project.name,
        workspaceId: project.workspace_id,
        wrappedDek: bufToB64(project.wrapped_dek),
        wrapIv: bufToB64(project.wrap_iv),
        environments,
      });
    }),
  },

  "/api/secrets/projects/:projectId/environments": {
    POST: tenantRoute(async (req, ctx) => {
      const { projectId } = req.params;
      const [project] = await ctx.tx`SELECT id FROM projects WHERE id = ${projectId}`;
      if (!project) throw new HttpError(404, "not found");
      const { name } = await req.json();
      if (!name) throw new HttpError(400, "name required");
      const [row] = await ctx.tx`
        INSERT INTO environments (project_id, name) VALUES (${projectId}, ${name}) RETURNING id, name
      `;
      return Response.json(row, { status: 201 });
    }),
  },

  "/api/secrets/environments/:envId/secrets": {
    GET: tenantRoute(async (req, ctx) => {
      const { envId } = req.params;
      const [env] = await ctx.tx`SELECT id FROM environments WHERE id = ${envId}`;
      if (!env) throw new HttpError(404, "not found");
      const rows = await ctx.tx`
        SELECT id, key_label, ciphertext, iv, version, updated_at
        FROM secrets WHERE environment_id = ${envId} ORDER BY key_label
      `;
      return Response.json(
        rows.map((r: any) => ({
          id: r.id,
          keyLabel: r.key_label,
          ciphertext: bufToB64(r.ciphertext),
          iv: bufToB64(r.iv),
          version: r.version,
          updatedAt: r.updated_at,
        }))
      );
    }),
    POST: tenantRoute(async (req, ctx) => {
      const { envId } = req.params;
      const [env] = await ctx.tx`SELECT id FROM environments WHERE id = ${envId}`;
      if (!env) throw new HttpError(404, "not found");
      const { keyLabel, ciphertext, iv } = await req.json();
      if (!keyLabel || !ciphertext || !iv) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO secrets (environment_id, key_label, ciphertext, iv, updated_by)
        VALUES (${envId}, ${keyLabel}, ${b64ToBuf(ciphertext)}, ${b64ToBuf(iv)}, ${ctx.userId})
        ON CONFLICT (environment_id, key_label) DO UPDATE SET
          ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
          version = secrets.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING id, key_label, version
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "secret:write",
        resourceType: "secret",
        resourceId: row.id,
        metadata: { keyLabel: row.key_label },
      });
      return Response.json(row, { status: 201 });
    }),
  },

  // Rate-limited per user, not just gated by auth: a stolen session could
  // otherwise script a mass dump of every secret at wire speed. 200/hour is
  // generous for real usage, tight enough to blunt a scripted dump.
  "/api/secrets/:secretId/reveal": {
    POST: rateLimited("secret-reveal", 200, 3600)(async (req, ctx) => {
      const { secretId } = req.params;
      const [row] = await ctx.tx`SELECT ciphertext, iv FROM secrets WHERE id = ${secretId}`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "secret:view", resourceType: "secret", resourceId: secretId });
      return Response.json({ ciphertext: bufToB64(row.ciphertext), iv: bufToB64(row.iv) });
    }),
  },

  "/api/secrets/:secretId/copy-event": {
    POST: rateLimited("secret-copy", 200, 3600)(async (req, ctx) => {
      const { secretId } = req.params;
      const [row] = await ctx.tx`SELECT id FROM secrets WHERE id = ${secretId}`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "secret:copy", resourceType: "secret", resourceId: secretId });
      return new Response(null, { status: 204 });
    }),
  },
};
