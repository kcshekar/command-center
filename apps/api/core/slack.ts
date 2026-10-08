import type { SQL } from "bun";
import { decryptSlackToken } from "./slack-crypto";

export interface SlackTestResult {
  ok: boolean;
  workspaceId?: string;
  botUserId?: string;
  scopes?: string[];
  error?: string;
}

export async function testSlackToken(botToken: string): Promise<SlackTestResult> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.error ?? "auth_test_failed" };

    const scopesHeader = res.headers.get("x-oauth-scopes");
    const scopes = scopesHeader ? scopesHeader.split(",").map((s) => s.trim()) : [];

    return {
      ok: true,
      workspaceId: data.team_id ?? data.url,
      botUserId: data.user_id,
      scopes,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "network_error" };
  }
}

export interface ResolvedSlackRoute {
  botToken: string;
  channelId: string;
  allowButtons: boolean;
  allowedApprovers: string[];
  source: "database" | "env_fallback";
}

export async function resolveSlackRoute(
  tx: SQL,
  orgId: string,
  routeKey: string
): Promise<ResolvedSlackRoute> {
  const rows = await tx`
    SELECT 
      c.encrypted_bot_token, c.bot_token_iv, c.status,
      r.channel_id, r.is_enabled, r.allow_buttons, r.allowed_approver_slack_ids
    FROM slack_routes r
    JOIN slack_connections c ON c.id = r.connection_id
    WHERE r.org_id = ${orgId} AND r.route_key = ${routeKey}
  `;

  const route = rows[0];
  if (route && route.is_enabled && route.status === "active") {
    const botToken = decryptSlackToken(route.encrypted_bot_token, route.bot_token_iv);
    return {
      botToken,
      channelId: route.channel_id,
      allowButtons: route.allow_buttons,
      allowedApprovers: route.allowed_approver_slack_ids ?? [],
      source: "database",
    };
  }

  // Fallback to legacy environment variables
  const envToken = process.env.SLACK_BOT_TOKEN;
  const envChannel = process.env.SLACK_CHANNEL_ID;

  if (envToken && envChannel) {
    return {
      botToken: envToken,
      channelId: envChannel,
      allowButtons: false,
      allowedApprovers: [],
      source: "env_fallback",
    };
  }

  throw new Error(`Slack not configured for route '${routeKey}' (no database route or env fallback found).`);
}

export async function sendSlackMessage(
  text: string,
  options?: { routeKey?: string; tx?: SQL; orgId?: string }
): Promise<void> {
  let botToken = process.env.SLACK_BOT_TOKEN;
  let channelId = process.env.SLACK_CHANNEL_ID;

  if (options?.tx && options?.orgId) {
    const routeKey = options.routeKey ?? "reminders.due";
    const resolved = await resolveSlackRoute(options.tx, options.orgId, routeKey);
    botToken = resolved.botToken;
    channelId = resolved.channelId;
  }

  if (!botToken || !channelId) {
    throw new Error("Slack not configured (SLACK_BOT_TOKEN / SLACK_CHANNEL_ID missing and no DB route)");
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channelId, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
}
