import { SocketModeClient } from "@slack/socket-mode";
import { sql } from "./db";
import { decryptSlackToken } from "./slack-crypto";
import { updateMessage } from "./slack-post";
import { log } from "./log";

// Long-lived WebSocket per DB connection that carries an app_token. Reads
// button clicks, verifies the approver is allowed for that route, and posts
// the decision to the Automations Worker's callback endpoint. Worker owns
// the Temporal Update dispatch — this file never talks to Temporal.
// ponytail: no Redis pub/sub hot-reload — restart pm2 on token change.
// Add hot-reload when token edits happen frequently enough to matter.

interface ButtonValue {
  workflowId: string;
  actionId: string;
  decision: "approve" | "reject";
  routeKey: string;
}

// Same shape as postBlockKit's return — used to update the message in place.
interface StoredMessageRef {
  channel: string;
  ts: string;
}

const active = new Map<string, SocketModeClient>();

// Called on boot and (later) whenever a connection changes. Iterates orgs
// and sets the per-tx GUC so RLS on slack_connections passes — same pattern
// as the reminder sweeper.
export async function startSlackSockets(): Promise<void> {
  const orgs = await sql`SELECT id FROM organizations`;
  const rows: Array<{ id: string; org_id: string; encrypted_app_token: string; app_token_iv: string }> = [];
  for (const org of orgs) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${org.id}, true)`;
      const found = await tx`
        SELECT id, org_id, encrypted_app_token, app_token_iv
        FROM slack_connections
        WHERE status = 'active' AND encrypted_app_token IS NOT NULL AND app_token_iv IS NOT NULL
      `;
      rows.push(...(found as any[]));
    });
  }

  for (const row of rows) {
    const key = row.id as string;
    if (active.has(key)) continue;

    const appToken = decryptSlackToken(row.encrypted_app_token, row.app_token_iv);
    const client = new SocketModeClient({ appToken });

    client.on("interactive", async ({ ack, body }: any) => {
      await ack();
      if (body?.type !== "block_actions") return;
      try {
        await handleAction(row.org_id, body);
      } catch (err) {
        log.error("slack action handler failed", { err: err instanceof Error ? err.message : String(err) });
      }
    });

    client.on("disconnect", () => {
      log.warn("slack socket disconnected", { connectionId: key });
    });

    await client.start();
    active.set(key, client);
    log.info("slack socket connected", { connectionId: key, orgId: row.org_id });
  }
}

async function handleAction(orgId: string, payload: any): Promise<void> {
  const action = payload?.actions?.[0];
  if (!action?.value) return;

  const parsed: ButtonValue = JSON.parse(action.value);
  const approverSlackId = payload.user?.id;
  const messageRef: StoredMessageRef = { channel: payload.channel.id, ts: payload.message.ts };

  // Verify approver is allowed for this route. RLS requires the org GUC.
  const route = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    const rows = await tx`
      SELECT allowed_approver_slack_ids, allow_buttons
      FROM slack_routes
      WHERE org_id = ${orgId} AND route_key = ${parsed.routeKey}
    `;
    log.info("slack route lookup", { routeKey: parsed.routeKey, orgId, found: rows.length });
    return rows[0] as { allowed_approver_slack_ids: string[] | null; allow_buttons: boolean } | undefined;
  });
  if (!route?.allow_buttons) throw new Error(`route ${parsed.routeKey} does not allow buttons`);
  const allowed: string[] = route.allowed_approver_slack_ids ?? [];
  if (allowed.length > 0 && !allowed.includes(approverSlackId)) {
    throw new Error(`user ${approverSlackId} not in allowed approvers for ${parsed.routeKey}`);
  }

  // Forward to worker.
  const workerUrl = process.env.WORKER_CALLBACK_URL;
  const workerToken = process.env.WORKER_CALLBACK_TOKEN;
  if (!workerUrl || !workerToken) throw new Error("WORKER_CALLBACK_URL/WORKER_CALLBACK_TOKEN not set");

  const res = await fetch(`${workerUrl}/callback/approval`, {
    method: "POST",
    headers: { Authorization: `Bearer ${workerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      workflowId: parsed.workflowId,
      actionId: parsed.actionId,
      decision: parsed.decision === "approve" ? "approved" : "rejected",
      approverSlackId,
      messageRef,
      orgId,
    }),
  });
  if (!res.ok) throw new Error(`worker callback ${res.status}: ${await res.text()}`);

  // Update the original message in place: swap buttons for a status line.
  // Same admin-background pattern the reminder sweeper uses — set the org
  // GUC on a bare tx (no per-user context needed for the token resolve).
  const badge = parsed.decision === "approve" ? "✅ Approved" : "❌ Rejected";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    await updateMessage(tx, orgId, parsed.routeKey, {
      channel: messageRef.channel,
      ts: messageRef.ts,
      text: `${badge} by <@${approverSlackId}>`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `${badge} by <@${approverSlackId}>` } }],
    });
  });
}
