import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { testSlackToken } from "../../core/slack";
import { encryptSlackToken, decryptSlackToken, maskToken } from "../../core/slack-crypto";
import { textArrayLiteral } from "../../core/pg-array";

export const slackRoutes = {
  "/api/slack/connections": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const rows = await ctx.tx`
        SELECT 
          id, name, workspace_id, bot_user_id, status, granted_scopes,
          last_verified_at, created_at, updated_at
        FROM slack_connections
        WHERE org_id = ${ctx.orgId}
        ORDER BY created_at DESC
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { name, botToken, appToken } = await req.json();
      if (!name || typeof name !== "string" || !name.trim()) throw new HttpError(400, "name is required");
      if (!botToken || typeof botToken !== "string" || !botToken.trim()) throw new HttpError(400, "botToken is required");

      const testRes = await testSlackToken(botToken.trim());
      if (!testRes.ok) throw new HttpError(400, `Slack token validation failed: ${testRes.error}`);

      const encBot = encryptSlackToken(botToken.trim());
      const encApp = appToken && typeof appToken === "string" && appToken.trim() ? encryptSlackToken(appToken.trim()) : null;

      const [conn] = await ctx.tx`
        INSERT INTO slack_connections (
          org_id, name, workspace_id, bot_user_id,
          encrypted_bot_token, bot_token_iv,
          encrypted_app_token, app_token_iv,
          granted_scopes, status, created_by
        ) VALUES (
          ${ctx.orgId}, ${name.trim()}, ${testRes.workspaceId!}, ${testRes.botUserId!},
          ${encBot.ciphertext}, ${encBot.iv},
          ${encApp ? encApp.ciphertext : null}, ${encApp ? encApp.iv : null},
          ${textArrayLiteral(testRes.scopes ?? [])}::text[], 'active', ${ctx.userId}
        )
        RETURNING id, name, workspace_id, bot_user_id, status, granted_scopes, last_verified_at, created_at
      `;

      await writeAudit(ctx.tx, ctx, { action: "slack_connection:create", resourceType: "slack_connection", resourceId: conn.id });
      return Response.json(conn, { status: 201 });
    }),
  },

  "/api/slack/connections/:connectionId": {
    PUT: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { connectionId } = req.params;
      const { name, botToken, appToken, status } = await req.json();

      const [existing] = await ctx.tx`SELECT id FROM slack_connections WHERE id = ${connectionId} AND org_id = ${ctx.orgId}`;
      if (!existing) throw new HttpError(404, "Connection not found");

      if (botToken && typeof botToken === "string" && botToken.trim()) {
        const testRes = await testSlackToken(botToken.trim());
        if (!testRes.ok) throw new HttpError(400, `Slack token validation failed: ${testRes.error}`);

        const encBot = encryptSlackToken(botToken.trim());
        const encApp = appToken && typeof appToken === "string" && appToken.trim() ? encryptSlackToken(appToken.trim()) : null;

        await ctx.tx`
          UPDATE slack_connections SET
            name = COALESCE(${name?.trim() || null}, name),
            workspace_id = ${testRes.workspaceId!},
            bot_user_id = ${testRes.botUserId!},
            encrypted_bot_token = ${encBot.ciphertext},
            bot_token_iv = ${encBot.iv},
            encrypted_app_token = ${encApp ? encApp.ciphertext : null},
            app_token_iv = ${encApp ? encApp.iv : null},
            granted_scopes = ${textArrayLiteral(testRes.scopes ?? [])}::text[],
            status = COALESCE(${status || null}, status),
            last_verified_at = now(),
            updated_at = now()
          WHERE id = ${connectionId}
        `;
      } else if (appToken && typeof appToken === "string" && appToken.trim()) {
        // App token added/updated without retyping the bot token — update
        // just the app-token fields. Previously this branch dropped the app
        // token silently, which left Socket Mode permanently disabled for
        // anyone who followed the "leave bot token blank" instruction.
        const encApp = encryptSlackToken(appToken.trim());
        await ctx.tx`
          UPDATE slack_connections SET
            name = COALESCE(${name?.trim() || null}, name),
            encrypted_app_token = ${encApp.ciphertext},
            app_token_iv = ${encApp.iv},
            status = COALESCE(${status || null}, status),
            updated_at = now()
          WHERE id = ${connectionId}
        `;
      } else {
        await ctx.tx`
          UPDATE slack_connections SET
            name = COALESCE(${name?.trim() || null}, name),
            status = COALESCE(${status || null}, status),
            updated_at = now()
          WHERE id = ${connectionId}
        `;
      }

      await writeAudit(ctx.tx, ctx, { action: "slack_connection:update", resourceType: "slack_connection", resourceId: connectionId });
      return Response.json({ ok: true });
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { connectionId } = req.params;
      const [deleted] = await ctx.tx`DELETE FROM slack_connections WHERE id = ${connectionId} AND org_id = ${ctx.orgId} RETURNING id`;
      if (!deleted) throw new HttpError(404, "Connection not found");
      await writeAudit(ctx.tx, ctx, { action: "slack_connection:delete", resourceType: "slack_connection", resourceId: connectionId });
      return new Response(null, { status: 204 });
    }),
  },

  "/api/slack/connections/:connectionId/test": {
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { connectionId } = req.params;
      const [conn] = await ctx.tx`
        SELECT encrypted_bot_token, bot_token_iv FROM slack_connections WHERE id = ${connectionId} AND org_id = ${ctx.orgId}
      `;
      if (!conn) throw new HttpError(404, "Connection not found");

      const botToken = decryptSlackToken(conn.encrypted_bot_token, conn.bot_token_iv);
      const testRes = await testSlackToken(botToken);

      const status = testRes.ok ? "active" : "error";
      await ctx.tx`
        UPDATE slack_connections SET
          status = ${status},
          granted_scopes = ${textArrayLiteral(testRes.scopes ?? [])}::text[],
          last_verified_at = now()
        WHERE id = ${connectionId}
      `;

      await writeAudit(ctx.tx, ctx, { action: "slack_connection:test", resourceType: "slack_connection", resourceId: connectionId, metadata: { ok: testRes.ok } });
      return Response.json(testRes);
    }),
  },

};
