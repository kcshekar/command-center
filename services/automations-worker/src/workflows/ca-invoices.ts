import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { caBatchCard, type PreparedBatch } from "../ca-card.js";
import { submitApproval } from "./inbox-triage.js";

// N12 — monthly CA invoices (catalog n12.ca, 5th at 10:00 IST). The parent
// prepares the batches and finishes; each batch gets its own abandoned child
// that waits for Approve / Hold, so one slow decision never blocks the next
// month (same shape as inbox triage's trash approval).

const { prepareCaBatches, postNotification } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes", // local model drafts one cover email per project
  retry: { maximumAttempts: 2 },
});
const { sendPreparedCaBatch, postApprovalNotification, updateApprovalNotification } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 }, // never risk emailing the CA twice
});

const APPROVAL_WINDOW = "3 days";

export async function caInvoicesWorkflow(input: { userId: string; approvalRouteKey: string; routeKey: string }) {
  const batches = await prepareCaBatches({ userId: input.userId });
  for (const b of batches) {
    if (!b.recipientEmail) {
      await postNotification(
        input.routeKey,
        `CA invoices for ${b.project} (${b.periodMonth}) are ready, but there's no CA email yet. Send this batch once from Finance → Business → Projects; next month will ask for approval here.`,
      );
      continue;
    }
    await wf.startChild(caBatchApprovalWorkflow, {
      args: [{ userId: input.userId, approvalRouteKey: input.approvalRouteKey, batch: b }],
      workflowId: `ca-batch-${b.batchId}`,
      parentClosePolicy: wf.ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
    });
  }
  return { prepared: batches.length };
}

export async function caBatchApprovalWorkflow(input: { userId: string; approvalRouteKey: string; batch: PreparedBatch }) {
  // Register before any await so a fast click can't be missed.
  let state: "pending" | "approved" | "rejected" = "pending";
  let approver = "";
  wf.setHandler(submitApproval, (p) => {
    state = p.decision;
    approver = p.approverSlackId;
    return { success: true };
  }, {
    validator: (_p) => {
      if (state !== "pending") throw new Error(`already ${state}`);
    },
  });

  const { text, summary } = caBatchCard(input.batch);
  const workflowId = wf.workflowInfo().workflowId;
  const actionId = `ca-${input.batch.batchId}`;
  const value = (decision: "approve" | "reject") => JSON.stringify({ workflowId, actionId, decision, routeKey: input.approvalRouteKey });
  const refs = await postApprovalNotification(input.approvalRouteKey, text, [
    { type: "header", text: { type: "plain_text", text: "📤 Send invoices to your CA?" } },
    { type: "section", text: { type: "mrkdwn", text: summary.slice(0, 2900) } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "approve_ca_batch", text: { type: "plain_text", text: "Send" }, style: "primary", value: value("approve") },
        { type: "button", action_id: "reject_ca_batch", text: { type: "plain_text", text: "Hold" }, value: value("reject") },
      ],
    },
  ], workflowId, actionId);

  const decided = await wf.condition(() => state !== "pending", APPROVAL_WINDOW);
  const by = approver ? ` by <@${approver}>` : "";
  if (!decided) {
    await updateApprovalNotification(input.approvalRouteKey, refs, "⌛ Not sent — no decision in 3 days. Edit and send it from Finance → Business → Projects.", "expired");
    return { sent: false };
  }
  if ((state as string) === "rejected") {
    await updateApprovalNotification(input.approvalRouteKey, refs, `⏸️ Held${by} — not sent. Edit and send it from Finance → Business → Projects.`, "rejected");
    return { sent: false };
  }
  try {
    await sendPreparedCaBatch({ userId: input.userId, batchId: input.batch.batchId });
    await updateApprovalNotification(input.approvalRouteKey, refs, `✅ Sent${by} to ${input.batch.recipientEmail} — ${input.batch.invoiceCount} invoice(s).`, "approved");
    return { sent: true };
  } catch (err) {
    await updateApprovalNotification(input.approvalRouteKey, refs, `⚠️ Approved but sending failed: ${String(err).slice(0, 160)}. Retry from Finance → Business → Projects.`, "approved");
    return { sent: false };
  }
}
