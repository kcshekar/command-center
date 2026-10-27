import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { mailReplyWorkflow } from "./mail-reply.js";
import { isTravelBooking } from "../parsers/travel.js";

const {
  fetchGmailHistory,
  commitGmailCursor,
  classifyEmailOllama,
  postNotification,
  postApprovalNotification,
  updateApprovalNotification,
  trashGmailMessages,
  ingestExpenseFromEmail,
  ingestBillReminder,
  ingestJobEmailLead,
  logReplyNeeded,
  ingestInterviewSchedulingEmail,
  ingestTravelBookingEmail,
} = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

export interface TriageInput {
  userEmail: string;
  digestRouteKey: string;   // e.g. "automations.digest"
  approvalRouteKey: string; // e.g. "automations.approval"
  userId?: string;          // A5.1: owning user for job_posting → A2 chain
  zone?: "personal" | "professional"; // P2: zone of this Gmail account (grant config); expenses land here
}

interface ApprovalPayload {
  actionId: string;
  decision: "approved" | "rejected";
  approverSlackId: string;
  messageRef: { channel: string; ts: string };
}

// Named Update — CC's slack-socket handler dispatches this via the worker
// callback server (see src/callback-server.ts). Lives on trashApprovalWorkflow;
// the button value carries that child's workflowId.
export const submitApproval = wf.defineUpdate<{ success: boolean }, [ApprovalPayload]>("submitApproval");

export async function inboxTriageWorkflow(input: TriageInput): Promise<{ proposed: number; ingestFailed: number }> {
  const { messages, historyId } = await fetchGmailHistory(input.userEmail);
  if (messages.length === 0) {
    await commitGmailCursor(input.userEmail, historyId);
    return { proposed: 0, ingestFailed: 0 };
  }

  // Classify, bucket, and ingest side-effect-free categories inline.
  //   transactional_bank → expense (deterministic parser → Ollama fallback)
  //   actionable_bill    → reminder (Ollama extract)
  // Both go straight to CC — no approval needed since they're add-only and
  // idempotent on (source, external_id) at the CC layer.
  const perCategory: Record<string, Array<{ id: string; subject: string; snippet: string; from: string }>> = {};
  let expensesIngested = 0;
  let billsIngested = 0;
  let jobsIngested = 0;         // A5.1 — job_posting → A2 job_leads
  let replyQueued = 0;          // A5.2 — needs_reply → mailReplyWorkflow child
  let interviewsIngested = 0;   // A5.3 — interview_scheduling → A4 session+round
  let tripsIngested = 0;        // R14 — confirmed travel bookings
  let ingestFailed = 0;

  for (const m of messages) {
    // R14: bookings are recognised deterministically and never go through the
    // classifier (so they can't be proposed for trash as "promotional").
    if (input.userId && isTravelBooking(m)) {
      try {
        const r = await ingestTravelBookingEmail(input.userId, input.userEmail, m);
        if (r.ok) tripsIngested++;
      } catch { ingestFailed++; }
      continue;
    }
    // No catch: if Ollama is unreachable the run fails here, the cursor is
    // never committed, and the next tick replays this batch. Downstream
    // ingests are idempotent on (source, externalId) so replays are safe.
    const c = await classifyEmailOllama({ subject: m.subject, snippet: m.snippet, from: m.from });
    const category = c?.category ?? "unclassified";
    (perCategory[category] ??= []).push({ id: m.id, subject: m.subject, snippet: m.snippet, from: m.from });

    if (category === "transactional_bank") {
      try {
        const r = await ingestExpenseFromEmail(
          m.id,
          { from: m.from, subject: m.subject, snippet: m.snippet },
          input.userId ? { userId: input.userId, zone: input.zone ?? "personal" } : undefined,
        );
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
    } else if (category === "job_posting" && input.userId) {
      // A5.1: route job alerts into A2's job_leads via the integration path.
      try {
        const r = await ingestJobEmailLead(input.userId, m);
        if (r.ok) jobsIngested++;
      } catch {
        ingestFailed++;
      }
    } else if (category === "interview_scheduling" && input.userId) {
      try {
        const r = await ingestInterviewSchedulingEmail(input.userId, input.userEmail, m);
        if (r.ok) interviewsIngested++;
      } catch { ingestFailed++; }
    } else if (category === "needs_reply" && input.userId) {
      // A5.2 — spawn mailReplyWorkflow as a parent-closed child so the triage
      // run completes immediately; the reply gets its own 24h approval window.
      try {
        await logReplyNeeded(m);
        await wf.startChild(mailReplyWorkflow, {
          args: [{
            userId: input.userId,
            userEmail: input.userEmail,
            messageId: m.id,
            subject: m.subject,
            from: m.from,
            approvalRouteKey: input.approvalRouteKey,
          }],
          workflowId: `mail-reply-${m.id}`,
          parentClosePolicy: wf.ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
        });
        replyQueued++;
      } catch (err) {
        // Already-started = idempotent re-ingest of the same message, skip.
        const name = err instanceof Error ? err.name : "";
        if (name !== "WorkflowExecutionAlreadyStartedError") {
          console.warn("[a5.mail] failed to spawn mailReplyWorkflow", { id: m.id, err: String(err) });
        }
      }
    }
  }

  const trashCandidates = [...(perCategory["promotional"] ?? []), ...(perCategory["spam"] ?? [])];

  const ingestionSummary =
    (expensesIngested || billsIngested || jobsIngested || replyQueued || interviewsIngested || tripsIngested || ingestFailed)
      ? `\n_Ingested: ${expensesIngested} expense(s), ${billsIngested} bill reminder(s), ${jobsIngested} job lead(s), ${replyQueued} reply queue(s), ${interviewsIngested} interview(s), ${tripsIngested} trip(s)${ingestFailed ? `, ${ingestFailed} failed` : ""}._`
      : "";

  // Everything above is ingested — safe to advance. Committing before the
  // trash child means a later failure can at worst skip a trash proposal.
  await commitGmailCursor(input.userEmail, historyId);

  // Nothing to approve → still post a digest so the owner sees the sweep ran.
  if (trashCandidates.length === 0) {
    await postNotification(
      input.digestRouteKey,
      `Inbox sweep: ${messages.length} new, nothing to trash.${ingestionSummary}`
    );
    return { proposed: 0, ingestFailed };
  }

  // The 24h approval wait runs in an abandoned child so this run completes
  // now — otherwise the schedule's SKIP overlap policy blocks every 15-min
  // tick until someone clicks the card.
  await wf.startChild(trashApprovalWorkflow, {
    args: [{ userEmail: input.userEmail, approvalRouteKey: input.approvalRouteKey, candidates: trashCandidates }],
    workflowId: `trash-approval-${wf.workflowInfo().workflowId}`,
    parentClosePolicy: wf.ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
  });
  return { proposed: trashCandidates.length, ingestFailed };
}

export interface TrashApprovalInput {
  userEmail: string;
  approvalRouteKey: string;
  candidates: Array<{ id: string; subject: string; from: string }>;
}

export async function trashApprovalWorkflow(input: TrashApprovalInput): Promise<{ trashed: number }> {
  // P0 #3 (race fix): register the Update handler BEFORE any I/O so a
  // fast-arriving button click can't miss it.
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

  const trashCandidates = input.candidates;

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

  const refs = await postApprovalNotification(
    input.approvalRouteKey,
    `Triage approval: ${trashCandidates.length} email(s)`,
    blocks,
    wf.workflowInfo().workflowId,
    actionId
  );

  const gotDecision = await wf.condition(() => state !== "pending", "24 hours");

  if (!gotDecision) {
    await updateApprovalNotification(input.approvalRouteKey, refs, "⌛ Approval expired after 24h — no emails were moved.", "expired");
    return { trashed: 0 };
  }

  const decision = state as "approved" | "rejected";

  if (decision === "rejected") {
    await updateApprovalNotification(
      input.approvalRouteKey, refs,
      `❌ Rejected${approver ? ` by <@${approver}>` : ""} — nothing moved.`,
      "rejected"
    );
    return { trashed: 0 };
  }

  const { trashed } = await trashGmailMessages(input.userEmail, trashCandidates.map((m) => m.id));
  await updateApprovalNotification(
    input.approvalRouteKey, refs,
    `✅ Approved${approver ? ` by <@${approver}>` : ""} — ${trashed} email(s) moved to trash.`,
    "approved"
  );
  return { trashed };
}
