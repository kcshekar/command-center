import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { textArrayLiteral } from "../../core/pg-array";

// Admin-facing route mappings (replaces /api/slack/routes) + per-user in-app
// notification queue (new).
//
// channel_type values supported today: 'slack' | 'in_app'. slack needs a
// slack_connections row + channel_id; in_app needs neither (fanouts to all
// users in the org).

const CHANNEL_TYPES = new Set(["slack", "in_app"]);

export const notificationRoutes = {
  "/api/notifications/routes": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const rows = await ctx.tx`
        SELECT
          r.id, r.route_key, r.channel_type, r.connection_id, c.name as connection_name,
          r.channel_id, r.channel_name, r.is_enabled, r.allow_buttons,
          r.allowed_approver_slack_ids, r.created_at, r.updated_at
        FROM notification_routes r
        LEFT JOIN slack_connections c ON c.id = r.connection_id
        WHERE r.org_id = ${ctx.orgId}
        ORDER BY r.route_key ASC
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { routeKey, channelType, connectionId, channelId, channelName, isEnabled, allowButtons, allowedApproverSlackIds } = await req.json();

      if (!routeKey || typeof routeKey !== "string" || !routeKey.trim()) throw new HttpError(400, "routeKey is required");
      const ct = (typeof channelType === "string" && channelType.trim()) || "slack";
      if (!CHANNEL_TYPES.has(ct)) throw new HttpError(400, `channelType must be one of: ${[...CHANNEL_TYPES].join(", ")}`);

      let resolvedConnId: string | null = null;
      let resolvedChannelId: string | null = null;
      if (ct === "slack") {
        if (!connectionId || typeof connectionId !== "string") throw new HttpError(400, "connectionId is required for slack routes");
        if (!channelId || typeof channelId !== "string" || !channelId.trim()) throw new HttpError(400, "channelId is required for slack routes");
        const [conn] = await ctx.tx`SELECT id FROM slack_connections WHERE id = ${connectionId} AND org_id = ${ctx.orgId}`;
        if (!conn) throw new HttpError(404, "Slack connection not found");
        resolvedConnId = connectionId;
        resolvedChannelId = channelId.trim();
      }

      const [route] = await ctx.tx`
        INSERT INTO notification_routes (
          org_id, route_key, channel_type, connection_id, channel_id, channel_name,
          is_enabled, allow_buttons, allowed_approver_slack_ids
        ) VALUES (
          ${ctx.orgId}, ${routeKey.trim()}, ${ct}, ${resolvedConnId}, ${resolvedChannelId}, ${channelName?.trim() || null},
          ${isEnabled ?? true}, ${allowButtons ?? false}, ${textArrayLiteral(allowedApproverSlackIds ?? [])}::text[]
        )
        ON CONFLICT (org_id, route_key, channel_type) DO UPDATE SET
          connection_id = EXCLUDED.connection_id,
          channel_id = EXCLUDED.channel_id,
          channel_name = EXCLUDED.channel_name,
          is_enabled = EXCLUDED.is_enabled,
          allow_buttons = EXCLUDED.allow_buttons,
          allowed_approver_slack_ids = EXCLUDED.allowed_approver_slack_ids,
          updated_at = now()
        RETURNING id, route_key, channel_type, channel_id, is_enabled
      `;

      await writeAudit(ctx.tx, ctx, { action: "notification_route:upsert", resourceType: "notification_route", resourceId: route.id, metadata: { routeKey, channelType: ct } });
      return Response.json(route, { status: 200 });
    }),
  },

  "/api/notifications/routes/:routeId": {
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { routeId } = req.params;
      const [deleted] = await ctx.tx`DELETE FROM notification_routes WHERE id = ${routeId} AND org_id = ${ctx.orgId} RETURNING id`;
      if (!deleted) throw new HttpError(404, "Route not found");
      await writeAudit(ctx.tx, ctx, { action: "notification_route:delete", resourceType: "notification_route", resourceId: routeId });
      return new Response(null, { status: 204 });
    }),
  },

  // ─── In-app notification queue (per-user) ──────────────────────────────────
  "/api/notifications": {
    GET: tenantRoute(async (req, ctx) => {
      const unreadOnly = new URL(req.url).searchParams.get("unread") === "1";
      const rows = await ctx.tx`
        SELECT id, route_key, text, blocks, is_approval, approval_state,
               approval_action_id, approval_workflow_id, read_at, created_at
        FROM notifications
        WHERE ${unreadOnly ? ctx.tx`read_at IS NULL` : ctx.tx`true`}
        ORDER BY created_at DESC
        LIMIT 100
      `;
      return Response.json(rows);
    }),
  },

  "/api/notifications/:notificationId/read": {
    POST: tenantRoute(async (req, ctx) => {
      const { notificationId } = req.params;
      await ctx.tx`UPDATE notifications SET read_at = now() WHERE id = ${notificationId} AND read_at IS NULL`;
      return Response.json({ ok: true });
    }),
  },

  "/api/notifications/:notificationId/respond": {
    POST: tenantRoute(async (req, ctx) => {
      const { notificationId } = req.params;
      const { decision } = await req.json();
      if (decision !== "approved" && decision !== "rejected") {
        throw new HttpError(400, "decision must be 'approved' or 'rejected'");
      }

      const [n] = await ctx.tx`
        SELECT id, is_approval, approval_state, approval_action_id, approval_workflow_id, route_key
        FROM notifications WHERE id = ${notificationId}
      `;
      if (!n) throw new HttpError(404, "notification not found");
      if (!n.is_approval) throw new HttpError(400, "not an approval notification");
      if (n.approval_state) throw new HttpError(409, `already ${n.approval_state}`);

      // Dispatch to the worker callback (same endpoint Slack handler uses).
      const workerUrl = process.env.WORKER_CALLBACK_URL;
      const workerToken = process.env.WORKER_CALLBACK_TOKEN;
      if (!workerUrl || !workerToken) throw new HttpError(500, "WORKER_CALLBACK_URL/TOKEN not set");
      const res = await fetch(`${workerUrl}/callback/approval`, {
        method: "POST",
        headers: { Authorization: `Bearer ${workerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: n.approval_workflow_id,
          actionId: n.approval_action_id,
          decision,
          approverSlackId: null,                        // in_app has no slack id
          messageRef: { channel: "in_app", ts: n.id },
          orgId: ctx.orgId,
        }),
      });
      if (!res.ok) throw new HttpError(502, `worker callback ${res.status}: ${await res.text()}`);

      await ctx.tx`
        UPDATE notifications
        SET approval_state = ${decision},
            approved_by = ${ctx.userId},
            approval_decided_at = now(),
            read_at = COALESCE(read_at, now())
        WHERE id = ${notificationId}
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "notification:approval",
        resourceType: "notification",
        resourceId: notificationId,
        metadata: { decision, routeKey: n.route_key },
      });
      return Response.json({ ok: true, decision });
    }),
  },
};
