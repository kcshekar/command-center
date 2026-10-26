import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const {
  fetchGmailMessageFull,
  draftReplyToEmail,
  sendGmailReply,
  postApprovalNotification,
  updateApprovalNotification,
} = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

// A5.2 — child workflow kicked off by inbox-triage when the classifier
// labels a message `needs_reply`. Fetch body → draft via Ollama → Slack
// approval (24h) → on approve, Gmail send. No send without a click.
// ponytail: approval window hardcoded 24h; feature-flag later if needed.

export interface MailReplyInput {
  userId: string;
  userEmail: string;
  messageId: string;
  subject: string;              // from the triage classifier's metadata
  from: string;
  approvalRouteKey: string;
}

interface ApprovalPayload {
  actionId: string;
  decision: "approved" | "rejected";
  approverSlackId: string;
  messageRef: { channel: string; ts: string };
}

export const submitReplyApproval = wf.defineUpdate<{ success: boolean }, [ApprovalPayload]>("submitReplyApproval");

export async function mailReplyWorkflow(input: MailReplyInput): Promise<{
  status: "sent" | "rejected" | "expired" | "no_body" | "draft_empty" | "send_failed";
  sentId?: string;
  reason?: string;
}> {
  // Register the update handler up front so a very fast click can't race us
  // (same pattern as the inbox-triage trash approval).
  type ApprovalState = "pending" | "approved" | "rejected";
  let state: ApprovalState = "pending";
  let approver = "";
  wf.setHandler(
    submitReplyApproval,
    (p) => {
      state = p.decision;
      approver = p.approverSlackId;
      return { success: true };
    },
    {
      validator: (_p) => {
        if (state !== "pending") throw new Error(`already processed as ${state}`);
      },
    }
  );

  // 1. Full body (snippet alone is too thin for the drafter).
  const full = await fetchGmailMessageFull(input.userEmail, input.messageId);
  if (!full.body) return { status: "no_body" };

  // 2. Draft via Ollama.
  const { reply } = await draftReplyToEmail({
    userId: input.userId,
    fullBody: full.body,
    subject: full.subject || input.subject,
    from: full.from || input.from,
  });
  if (!reply) return { status: "draft_empty" };

  // 3. Slack approval card. Buttons encode {workflowId, actionId, decision}
  // so the socket-mode handler can round-trip through the worker callback.
  const actionId = `mail-reply-${wf.workflowInfo().workflowId}`;
  const buttonValue = (decision: "approve" | "reject") => JSON.stringify({
    workflowId: wf.workflowInfo().workflowId,
    actionId,
    decision,
    routeKey: input.approvalRouteKey,
    updateName: "submitReplyApproval",
  });
  const preview = reply.length > 1200 ? reply.slice(0, 1200) + "\n…" : reply;
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "✉️ Mail reply approval" } },
    { type: "section", text: { type: "mrkdwn", text: `*To:* ${input.from}\n*Re:* ${full.subject || input.subject}` } },
    { type: "section", text: { type: "mrkdwn", text: "*Draft:*\n```" + preview + "```" } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "approve_reply", text: { type: "plain_text", text: "Send" }, style: "primary", value: buttonValue("approve") },
        { type: "button", action_id: "reject_reply", text: { type: "plain_text", text: "Discard" }, style: "danger", value: buttonValue("reject") },
      ],
    },
  ];
  const refs = await postApprovalNotification(
    input.approvalRouteKey,
    `Reply approval for ${full.from || input.from}`,
    blocks,
    wf.workflowInfo().workflowId,
    actionId,
  );

  const gotDecision = await wf.condition(() => state !== "pending", "24 hours");
  if (!gotDecision) {
    await updateApprovalNotification(input.approvalRouteKey, refs, "⌛ Reply approval expired after 24h — not sent.");
    return { status: "expired" };
  }
  if ((state as ApprovalState) === "rejected") {
    await updateApprovalNotification(input.approvalRouteKey, refs,
      `❌ Discarded${approver ? ` by <@${approver}>` : ""} — reply not sent.`);
    return { status: "rejected" };
  }

  // 4. Approved → send.
  try {
    const { sentId } = await sendGmailReply({
      userEmail: input.userEmail,
      threadId: full.threadId,
      to: full.from || input.from,       // reply-to the From address
      subject: full.subject || input.subject,
      body: reply,
      inReplyTo: full.messageIdHeader,
    });
    await updateApprovalNotification(input.approvalRouteKey, refs,
      `✅ Sent${approver ? ` by <@${approver}>` : ""} — Gmail id ${sentId}.`);
    return { status: "sent", sentId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateApprovalNotification(input.approvalRouteKey, refs,
      `⚠️ Send failed after approval: ${msg.slice(0, 160)}`);
    return { status: "send_failed", reason: msg };
  }
}
