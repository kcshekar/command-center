import { tenantRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";

export const knowledgeRoutes = {
  "/api/kb/commands": {
    GET: tenantRoute(async (req, ctx) => {
      const context = new URL(req.url).searchParams.get("context");
      const rows = context
        ? await ctx.tx`SELECT id, title, command_text, context, notes, created_by, updated_at FROM kb_commands WHERE context = ${context} ORDER BY updated_at DESC`
        : await ctx.tx`SELECT id, title, command_text, context, notes, created_by, updated_at FROM kb_commands ORDER BY updated_at DESC`;
      return Response.json(rows);
    }),
    POST: tenantRoute(async (req, ctx) => {
      const { title, commandText, context, notes } = await req.json();
      if (!title || !commandText) throw new HttpError(400, "title and commandText required");
      const [row] = await ctx.tx`
        INSERT INTO kb_commands (org_id, title, command_text, context, notes, created_by)
        VALUES (${ctx.orgId}, ${title}, ${commandText}, ${context ?? null}, ${notes ?? null}, ${ctx.userId})
        RETURNING id, title, command_text, context, notes, created_at
      `;
      await writeAudit(ctx.tx, ctx, { action: "kb_command:create", resourceType: "kb_command", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },

  "/api/kb/commands/:commandId": {
    GET: tenantRoute(async (req, ctx) => {
      const { commandId } = req.params;
      const [command] = await ctx.tx`SELECT * FROM kb_commands WHERE id = ${commandId}`;
      if (!command) throw new HttpError(404, "not found");
      const comments = await ctx.tx`
        SELECT id, author_id, body, created_at FROM kb_comments WHERE command_id = ${commandId} ORDER BY created_at
      `;
      const attachments = await ctx.tx`
        SELECT id, filename, content_type, size_bytes, uploaded_by, uploaded_at
        FROM attachments WHERE resource_type = 'kb_command' AND resource_id = ${commandId}
      `;
      return Response.json({ ...command, comments, attachments });
    }),
    PUT: tenantRoute(async (req, ctx) => {
      const { commandId } = req.params;
      const { title, commandText, context, notes } = await req.json();
      if (!title || !commandText) throw new HttpError(400, "title and commandText required");
      const [row] = await ctx.tx`
        UPDATE kb_commands SET title = ${title}, command_text = ${commandText}, context = ${context ?? null},
          notes = ${notes ?? null}, updated_at = now()
        WHERE id = ${commandId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "kb_command:update", resourceType: "kb_command", resourceId: commandId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const { commandId } = req.params;
      const [row] = await ctx.tx`DELETE FROM kb_commands WHERE id = ${commandId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "kb_command:delete", resourceType: "kb_command", resourceId: commandId });
      return new Response(null, { status: 204 });
    }),
  },

  "/api/kb/commands/:commandId/comments": {
    POST: tenantRoute(async (req, ctx) => {
      const { commandId } = req.params;
      const [command] = await ctx.tx`SELECT id FROM kb_commands WHERE id = ${commandId}`;
      if (!command) throw new HttpError(404, "not found");
      const { body } = await req.json();
      if (!body) throw new HttpError(400, "body required");
      const [row] = await ctx.tx`
        INSERT INTO kb_comments (org_id, command_id, author_id, body)
        VALUES (${ctx.orgId}, ${commandId}, ${ctx.userId}, ${body})
        RETURNING id, body, created_at
      `;
      await writeAudit(ctx.tx, ctx, { action: "kb_comment:create", resourceType: "kb_comment", resourceId: row.id, metadata: { commandId } });
      return Response.json(row, { status: 201 });
    }),
  },
};
