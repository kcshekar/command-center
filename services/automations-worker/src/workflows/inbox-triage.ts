import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const {
  fetchGmailHistory,
  classifyEmailOllama,
  postSlackMessage,
  postApprovalCard,
  updateApprovalMessage,
  trashGmailMessages,
  ingestExpenseFromEmail,
  ingestBillReminder,
} = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

export interface TriageInput {
  userEmail: string;
  digestRouteKey: string;   // e.g. "automations.digest"
  approvalRouteKey: string; // e.g. "automations.approval"
}

interface ApprovalPayload {
  actionId: string;
  decision: "approved" | "rejected";
  approverSlackId: string;
  messageRef: { channel: string; ts: string };
}

// Named Update — CC's slack-socket handler dispatches this via the worker
// callback server (see src/callback-server.ts).
export const submitApproval = wf.defineUpdate<{ success: boolean }, [ApprovalPayload]>("submitApproval");

export async function inboxTriageWorkflow(input: TriageInput): Promise<{ trashed: number; proposed: number; ingestFailed: number }> {
  // P0 #3 (race fix): register the Update handler BEFORE any I/O so a
  // fast-arriving button click can't miss it. Cheap to register early even
  // though the update can't actually fire until we've posted the card.
  let state: "pending" | "approved" | "rejected" = "pending";
  let approver = "";
  wf.setHandler(
    submitApproval,
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

  const messages = await fetchGmailHistory(input.userEmail);
  if (messages.length === 0) return { trashed: 0, proposed: 0, ingestFailed: 0 };

  // Classify, bucket, and ingest side-effect-free categories inline.
  //   transactional_bank → expense (deterministic parser → Ollama fallback)
  //   actionable_bill    → reminder (Ollama extract)
  // Both go straight to CC — no approval needed since they're add-only and
  // idempotent on (source, external_id) at the CC layer.
  const perCategory: Record<string, Array<{ id: string; subject: string; snippet: string; from: string }>> = {};
  let expensesIngested = 0;
  let billsIngested = 0;
  let ingestFailed = 0; // P0 #1: track CC-side failures instead of crashing the whole sweep

  for (const m of messages) {
    let category = "unclassified";
    try {
      const c = await classifyEmailOllama({ subject: m.subject, snippet: m.snippet, from: m.from });
      category = c.category;
    } catch {
      /* keep as unclassified */
    }
    (perCategory[category] ??= []).push({ id: m.id, subject: m.subject, snippet: m.snippet, from: m.from });

    if (category === "transactional_bank") {
      try {
        const r = await ingestExpenseFromEmail(m.id, { from: m.from, subject: m.subject, snippet: m.snippet });
        if (r.ok) expensesIngested++;
      } catch {
        ingestFailed++;
      }
    } else if (category === "actionable_bill") {
      try {
        const r = await ingestBillReminder(m.id, { from: m.from, subject: m.subject, snippet: m.snippet });
        if (r.ok) billsIngested++;
      } catch {
        ingestFailed++;
      }
    }
  }

  const trashCandidates = [...(perCategory["promotional"] ?? []), ...(perCategory["spam"] ?? [])];

  const ingestionSummary =
    (expensesIngested || billsIngested || ingestFailed)
      ? `\n_Ingested: ${expensesIngested} expense(s), ${billsIngested} bill reminder(s)${ingestFailed ? `, ${ingestFailed} failed` : ""}._`
      : "";

  // Nothing to approve → still post a digest so the owner sees the sweep ran.
  if (trashCandidates.length === 0) {
    await postSlackMessage(
      input.digestRouteKey,
      `Inbox sweep: ${messages.length} new, nothing to trash.${ingestionSummary}`
    );
    return { trashed: 0, proposed: 0, ingestFailed };
  }

  // Post the approval card. Include workflowId + actionId in each button so
  // the socket-mode handler can round-trip it back to us.
  const actionId = `triage-${wf.workflowInfo().workflowId}`;
  const preview = trashCandidates.slice(0, 5).map((m) => `• ${m.subject} — ${m.from}`).join("\n");
  const more = trashCandidates.length > 5 ? `\n_+ ${trashCandidates.length - 5} more_` : "";
  const buttonValue = (decision: "approve" | "reject") => JSON.stringify({
    workflowId: wf.workflowInfo().workflowId,
    actionId,
    decision,
    routeKey: input.approvalRouteKey,
  });
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "📥 Inbox Triage Approval" } },
    { type: "section", text: { type: "mrkdwn", text: `*${trashCandidates.length} email(s) classified for trash:*\n${preview}${more}` } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "approve_triage", text: { type: "plain_text", text: "Approve Trash" }, style: "danger", value: buttonValue("approve") },
        { type: "button", action_id: "reject_triage", text: { type: "plain_text", text: "Keep All" }, style: "primary", value: buttonValue("reject") },
      ],
    },
  ];

  const posted = await postApprovalCard(input.approvalRouteKey, `Triage approval: ${trashCandidates.length} email(s)`, blocks);

  const gotDecision = await wf.condition(() => state !== "pending", "24 hours");

  if (!gotDecision) {
    await updateApprovalMessage(input.approvalRouteKey, posted.channel, posted.ts, "⌛ Approval expired after 24h — no emails were moved.");
    return { trashed: 0, proposed: trashCandidates.length, ingestFailed };
  }

  if (state === "rejected") {
    // Slack handler already updated the message with the "❌ Rejected" badge.
    return { trashed: 0, proposed: trashCandidates.length, ingestFailed };
  }

  const { trashed } = await trashGmailMessages(input.userEmail, trashCandidates.map((m) => m.id));
  await updateApprovalMessage(
    input.approvalRouteKey,
    posted.channel,
    posted.ts,
    `✅ Approved by <@${approver}> — ${trashed} email(s) moved to trash.`
  );
  return { trashed, proposed: trashCandidates.length, ingestFailed };
}
