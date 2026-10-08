import type { SQL } from "bun";
import { WebClient } from "@slack/web-api";
import { resolveSlackRoute } from "./slack";

// Wraps @slack/web-api against a resolved route. The registry's decrypted
// bot token drives one WebClient per call — reused clients aren't needed
// here (throughput is 2-3 posts/day).

export interface PostedMessage {
  channel: string;
  ts: string;
}

export async function postBlockKit(
  tx: SQL,
  orgId: string,
  routeKey: string,
  args: { text: string; blocks?: unknown[] }
): Promise<PostedMessage> {
  const route = await resolveSlackRoute(tx, orgId, routeKey);
  const client = new WebClient(route.botToken);
  const res = await client.chat.postMessage({
    channel: route.channelId,
    text: args.text,
    blocks: args.blocks as any,
  });
  if (!res.ok || !res.ts || !res.channel) throw new Error(`Slack post failed: ${res.error ?? "unknown"}`);
  return { channel: res.channel, ts: res.ts };
}

export async function updateMessage(
  tx: SQL,
  orgId: string,
  routeKey: string,
  args: { channel: string; ts: string; text: string; blocks?: unknown[] }
): Promise<void> {
  const route = await resolveSlackRoute(tx, orgId, routeKey);
  const client = new WebClient(route.botToken);
  const res = await client.chat.update({
    channel: args.channel,
    ts: args.ts,
    text: args.text,
    blocks: args.blocks as any,
  });
  if (!res.ok) throw new Error(`Slack update failed: ${res.error ?? "unknown"}`);
}
