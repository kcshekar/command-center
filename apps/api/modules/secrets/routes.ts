import { tenantRoute, rateLimited } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { extractKeyValuePairs } from "../../core/ollama";

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
      return Response.json(await ctx.tx`
        SELECT p.id, p.name, p.created_at, count(e.id)::int AS environment_count
        FROM projects p LEFT JOIN environments e ON e.project_id = p.id
        WHERE p.workspace_id = ${workspaceId}
        GROUP BY p.id
        ORDER BY p.created_at
      `);
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
      const environments = await ctx.tx`
        SELECT e.id, e.name, count(s.id)::int AS secret_count
        FROM environments e LEFT JOIN secrets s ON s.environment_id = e.id
        WHERE e.project_id = ${projectId}
        GROUP BY e.id
        ORDER BY e.name
      `;
      return Response.json({
        id: project.id,
        name: project.name,
        workspaceId: project.workspace_id,
        wrappedDek: bufToB64(project.wrapped_dek),
        wrapIv: bufToB64(project.wrap_iv),
        environments,
      });
    }),
    PUT: tenantRoute(async (req, ctx) => {
      const { projectId } = req.params;
      const { name } = await req.json();
      if (!name) throw new HttpError(400, "name required");
      const [row] = await ctx.tx`UPDATE projects SET name = ${name} WHERE id = ${projectId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "project:update", resourceType: "project", resourceId: projectId });
      return Response.json({ ok: true });
    }),
    // Cascades to its environments and secrets (ON DELETE CASCADE) — deleting
    // a project deletes everything under it, no orphaned rows.
    DELETE: tenantRoute(async (req, ctx) => {
      const { projectId } = req.params;
      const [row] = await ctx.tx`DELETE FROM projects WHERE id = ${projectId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "project:delete", resourceType: "project", resourceId: projectId });
      return new Response(null, { status: 204 });
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
      await writeAudit(ctx.tx, ctx, { action: "environment:create", resourceType: "environment", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },

  "/api/secrets/environments/:envId": {
    PUT: tenantRoute(async (req, ctx) => {
      const { envId } = req.params;
      const { name } = await req.json();
      if (!name) throw new HttpError(400, "name required");
      const [row] = await ctx.tx`UPDATE environments SET name = ${name} WHERE id = ${envId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "environment:update", resourceType: "environment", resourceId: envId });
      return Response.json({ ok: true });
    }),
    // Cascades to its secrets (ON DELETE CASCADE).
    DELETE: tenantRoute(async (req, ctx) => {
      const { envId } = req.params;
      const [row] = await ctx.tx`DELETE FROM environments WHERE id = ${envId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "environment:delete", resourceType: "environment", resourceId: envId });
      return new Response(null, { status: 204 });
    }),
  },

  "/api/secrets/environments/:envId/secrets": {
    GET: tenantRoute(async (req, ctx) => {
      const { envId } = req.params;
      const [env] = await ctx.tx`SELECT id FROM environments WHERE id = ${envId}`;
      if (!env) throw new HttpError(404, "not found");
      const rows = await ctx.tx`
        SELECT id, key_label, ciphertext, iv, note_ciphertext, note_iv, version, updated_at
        FROM secrets WHERE environment_id = ${envId} ORDER BY key_label
      `;
      return Response.json(
        rows.map((r: any) => ({
          id: r.id,
          keyLabel: r.key_label,
          ciphertext: bufToB64(r.ciphertext),
          iv: bufToB64(r.iv),
          noteCiphertext: r.note_ciphertext ? bufToB64(r.note_ciphertext) : null,
          noteIv: r.note_iv ? bufToB64(r.note_iv) : null,
          version: r.version,
          updatedAt: r.updated_at,
        }))
      );
    }),
    POST: tenantRoute(async (req, ctx) => {
      const { envId } = req.params;
      const [env] = await ctx.tx`SELECT id FROM environments WHERE id = ${envId}`;
      if (!env) throw new HttpError(404, "not found");
      const { keyLabel, ciphertext, iv, noteCiphertext, noteIv } = await req.json();
      if (!keyLabel || !ciphertext || !iv) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO secrets (environment_id, key_label, ciphertext, iv, note_ciphertext, note_iv, updated_by)
        VALUES (${envId}, ${keyLabel}, ${b64ToBuf(ciphertext)}, ${b64ToBuf(iv)},
                ${noteCiphertext ? b64ToBuf(noteCiphertext) : null}, ${noteIv ? b64ToBuf(noteIv) : null},
                ${ctx.userId})
        ON CONFLICT (environment_id, key_label) DO UPDATE SET
          ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
          note_ciphertext = EXCLUDED.note_ciphertext, note_iv = EXCLUDED.note_iv,
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

  // Dedicated edit-by-id, distinct from the POST upsert-by-key_label above:
  // that path can't rename a key (a new key_label just inserts a new row),
  // this one can — key_label and/or the value can change in place.
  "/api/secrets/:secretId": {
    PUT: tenantRoute(async (req, ctx) => {
      const { secretId } = req.params;
      // note_ciphertext/note_iv are always written when the client sends them
      // (client always includes on edit; null means "clear the note"). Value
      // fields keep the existing "omit to leave alone" semantics.
      const { keyLabel, ciphertext, iv, noteCiphertext, noteIv } = await req.json();
      const [row] = await ctx.tx`
        UPDATE secrets SET
          key_label = COALESCE(${keyLabel ?? null}, key_label),
          ciphertext = COALESCE(${ciphertext ? b64ToBuf(ciphertext) : null}, ciphertext),
          iv = COALESCE(${iv ? b64ToBuf(iv) : null}, iv),
          note_ciphertext = ${noteCiphertext ? b64ToBuf(noteCiphertext) : null},
          note_iv = ${noteIv ? b64ToBuf(noteIv) : null},
          version = version + 1, updated_by = ${ctx.userId}, updated_at = now()
        WHERE id = ${secretId}
        RETURNING id, key_label, version
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "secret:update", resourceType: "secret", resourceId: secretId, metadata: { keyLabel: row.key_label } });
      return Response.json(row);
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const { secretId } = req.params;
      const [row] = await ctx.tx`DELETE FROM secrets WHERE id = ${secretId} RETURNING id, key_label`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "secret:delete", resourceType: "secret", resourceId: secretId, metadata: { keyLabel: row.key_label } });
      return new Response(null, { status: 204 });
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

  // Fallback for the bulk-import dialog: only hit when the pasted/uploaded
  // text isn't clean JSON or .env syntax (the frontend tries both directly
  // first). Doesn't touch any project/environment data — just text in,
  // key-value JSON out — so no RLS-relevant scoping needed here.
  "/api/secrets/extract": {
    POST: rateLimited("secret-extract", 20, 3600)(async (req, _ctx) => {
      const { text } = await req.json();
      if (!text || typeof text !== "string") throw new HttpError(400, "text required");
      const pairs = await extractKeyValuePairs(text);
      return Response.json(pairs);
    }),
  },
};
