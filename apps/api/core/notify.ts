import type { SQL } from "bun";
import { postBlockKit as slackPostBlockKit, updateMessage as slackUpdateMessage } from "./slack-post";
import { sendSlackMessage as slackSend } from "./slack";

// Dispatcher for notification routes. A route_key can have multiple rows (one
// per channel_type) — fan-out posts to all of them. Approvals fan out too;
// the first click wins and the update loop settles the other postings.

export interface PostedRef {
  channel: string;       // Slack channel id, or 'in_app' sentinel
  ts: string;            // Slack timestamp, or notifications.id uuid for in_app
}

interface RouteRow {
  channel_type: string;
  allow_buttons: boolean;
}

async function loadRoutes(tx: SQL, orgId: string, routeKey: string): Promise<RouteRow[]> {
  const rows = await tx`
    SELECT channel_type, allow_buttons
    FROM notification_routes
    WHERE org_id = ${orgId} AND route_key = ${routeKey} AND is_enabled = true
  `;
  if (rows.length === 0) throw new Error(`notification route '${routeKey}' not found or disabled`);
  return rows as RouteRow[];
}

async function dispatchOne(
  tx: SQL,
  orgId: string,
  routeKey: string,
  channelType: string,
  args: { text: string; blocks?: unknown[] }
): Promise<PostedRef | null> {
  if (channelType === "slack") {
    await slackSend(args.text, { routeKey, tx, orgId });
    return null;
  }
  if (channelType === "in_app") {
    const [row] = await tx`
      INSERT INTO notifications (org_id, recipient_user_id, route_key, text, blocks)
      SELECT ${orgId}, u.id, ${routeKey}, ${args.text}, ${args.blocks ? JSON.stringify(args.blocks) : null}::jsonb
      FROM users u WHERE u.org_id = ${orgId}
      RETURNING id
    `;
    return row ? { channel: "in_app", ts: row.id as string } : null;
  }
  throw new Error(`unknown channel_type '${channelType}' for route '${routeKey}'`);
}

export async function notify(
  tx: SQL,
  orgId: string,
  routeKey: string,
  args: { text: string; blocks?: unknown[] }
): Promise<void> {
  const routes = await loadRoutes(tx, orgId, routeKey);
  for (const route of routes) {
    await dispatchOne(tx, orgId, routeKey, route.channel_type, args);
  }
}

export async function postApproval(
  tx: SQL,
  orgId: string,
  routeKey: string,
  args: { text: string; blocks: unknown[]; workflowId: string; actionId: string }
): Promise<PostedRef[]> {
  const routes = await loadRoutes(tx, orgId, routeKey);
  const refs: PostedRef[] = [];
  for (const route of routes) {
    if (!route.allow_buttons) {
      throw new Error(`route '${routeKey}' (channel ${route.channel_type}) does not allow buttons`);
    }
    if (route.channel_type === "slack") {
      const posted = await slackPostBlockKit(tx, orgId, routeKey, { text: args.text, blocks: args.blocks });
      refs.push(posted);
      continue;
    }
    if (route.channel_type === "in_app") {
      const [row] = await tx`
        INSERT INTO notifications (
          org_id, recipient_user_id, route_key, text, blocks,
          is_approval, approval_action_id, approval_workflow_id
        )
        SELECT ${orgId}, u.id, ${routeKey}, ${args.text}, ${JSON.stringify(args.blocks)}::jsonb,
               true, ${args.actionId}, ${args.workflowId}
        FROM users u WHERE u.org_id = ${orgId}
        LIMIT 1
        RETURNING id
      `;
      if (!row) throw new Error(`no user in org ${orgId} to receive in-app approval`);
      refs.push({ channel: "in_app", ts: row.id as string });
      continue;
    }
    throw new Error(`unknown channel_type '${route.channel_type}'`);
  }
  return refs;
}

export async function updateNotification(
  tx: SQL,
  orgId: string,
  routeKey: string,
  refs: PostedRef[],
  args: { text: string; blocks?: unknown[] }
): Promise<void> {
  for (const ref of refs) {
    if (ref.channel === "in_app") {
      await tx`
        UPDATE notifications
        SET text = ${args.text},
            blocks = ${args.blocks ? JSON.stringify(args.blocks) : null}::jsonb
        WHERE id = ${ref.ts} AND org_id = ${orgId}
      `;
      continue;
    }
    // Slack ref — channel is a Slack channel id.
    await slackUpdateMessage(tx, orgId, routeKey, {
      channel: ref.channel,
      ts: ref.ts,
      text: args.text,
      blocks: args.blocks,
    });
  }
}
