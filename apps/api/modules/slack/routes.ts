import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { testSlackToken } from "../../core/slack";
import { encryptSlackToken, decryptSlackToken, maskToken } from "../../core/slack-crypto";
import { textArrayLiteral } from "../../core/pg-array";

export const slackRoutes = {
  "/api/slack/env-status": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const envConfigured = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID);
      const [countRow] = await ctx.tx`
        SELECT COUNT(*)::int as count FROM slack_connections WHERE org_id = ${ctx.orgId}
      `;
      return Response.json({
        envConfigured,
        hasDbConnections: (countRow?.count ?? 0) > 0,
      });
    }),
  },

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

  "/api/slack/routes": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const rows = await ctx.tx`
        SELECT 
          r.id, r.route_key, r.connection_id, c.name as connection_name,
          r.channel_id, r.channel_name, r.is_enabled, r.allow_buttons,
          r.allowed_approver_slack_ids, r.created_at, r.updated_at
        FROM slack_routes r
        JOIN slack_connections c ON c.id = r.connection_id
        WHERE r.org_id = ${ctx.orgId}
        ORDER BY r.route_key ASC
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { routeKey, connectionId, channelId, channelName, isEnabled, allowButtons, allowedApproverSlackIds } = await req.json();

      if (!routeKey || typeof routeKey !== "string" || !routeKey.trim()) throw new HttpError(400, "routeKey is required");
      if (!connectionId || typeof connectionId !== "string") throw new HttpError(400, "connectionId is required");
      if (!channelId || typeof channelId !== "string" || !channelId.trim()) throw new HttpError(400, "channelId is required");

      const [conn] = await ctx.tx`SELECT id FROM slack_connections WHERE id = ${connectionId} AND org_id = ${ctx.orgId}`;
      if (!conn) throw new HttpError(404, "Connection not found");

      const [route] = await ctx.tx`
        INSERT INTO slack_routes (
          org_id, route_key, connection_id, channel_id, channel_name,
          is_enabled, allow_buttons, allowed_approver_slack_ids
        ) VALUES (
          ${ctx.orgId}, ${routeKey.trim()}, ${connectionId}, ${channelId.trim()}, ${channelName?.trim() || null},
          ${isEnabled ?? true}, ${allowButtons ?? false}, ${textArrayLiteral(allowedApproverSlackIds ?? [])}::text[]
        )
        ON CONFLICT (org_id, route_key) DO UPDATE SET
          connection_id = EXCLUDED.connection_id,
          channel_id = EXCLUDED.channel_id,
          channel_name = EXCLUDED.channel_name,
          is_enabled = EXCLUDED.is_enabled,
          allow_buttons = EXCLUDED.allow_buttons,
          allowed_approver_slack_ids = EXCLUDED.allowed_approver_slack_ids,
          updated_at = now()
        RETURNING id, route_key, channel_id, is_enabled
      `;

      await writeAudit(ctx.tx, ctx, { action: "slack_route:upsert", resourceType: "slack_route", resourceId: route.id, metadata: { routeKey } });
      return Response.json(route, { status: 200 });
    }),
  },

  "/api/slack/routes/:routeId": {
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { routeId } = req.params;
      const [deleted] = await ctx.tx`DELETE FROM slack_routes WHERE id = ${routeId} AND org_id = ${ctx.orgId} RETURNING id`;
      if (!deleted) throw new HttpError(404, "Route not found");
      await writeAudit(ctx.tx, ctx, { action: "slack_route:delete", resourceType: "slack_route", resourceId: routeId });
      return new Response(null, { status: 204 });
    }),
  },

  "/api/slack/migrate-env": {
    POST: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const envToken = process.env.SLACK_BOT_TOKEN;
      const envChannel = process.env.SLACK_CHANNEL_ID;

      if (!envToken || !envChannel) {
        throw new HttpError(400, "No SLACK_BOT_TOKEN or SLACK_CHANNEL_ID found in environment variables");
      }

      const testRes = await testSlackToken(envToken);
      if (!testRes.ok) {
        throw new HttpError(400, `Environment bot token invalid: ${testRes.error}`);
      }

      const encBot = encryptSlackToken(envToken);
      const [conn] = await ctx.tx`
        INSERT INTO slack_connections (
          org_id, name, workspace_id, bot_user_id,
          encrypted_bot_token, bot_token_iv,
          granted_scopes, status, created_by
        ) VALUES (
          ${ctx.orgId}, 'Default Env Bot', ${testRes.workspaceId!}, ${testRes.botUserId!},
          ${encBot.ciphertext}, ${encBot.iv},
          ${textArrayLiteral(testRes.scopes ?? [])}::text[], 'active', ${ctx.userId}
        )
        RETURNING id
      `;

      const [route] = await ctx.tx`
        INSERT INTO slack_routes (
          org_id, route_key, connection_id, channel_id, channel_name, is_enabled
        ) VALUES (
          ${ctx.orgId}, 'reminders.due', ${conn.id}, ${envChannel}, '#env-channel', true
        )
        ON CONFLICT (org_id, route_key) DO UPDATE SET
          connection_id = EXCLUDED.connection_id,
          channel_id = EXCLUDED.channel_id,
          is_enabled = true
        RETURNING id
      `;

      await writeAudit(ctx.tx, ctx, { action: "slack:migrate_env", resourceType: "slack_connection", resourceId: conn.id });
      return Response.json({ migrated: true, connectionId: conn.id, routeId: route.id });
    }),
  },
};
