import { cc } from "../cc-client.js";
import { todayIn } from "../money-dates.js";
import { previousMonth, type PreparedBatch } from "../ca-card.js";

// N12 — monthly CA invoices. On the 5th: prepare last month's batch per
// finance project (existing CA flow: invoices + locally drafted cover email),
// then each batch waits for approval (Slack + Inbox). Only Approve emails it.

export async function prepareCaBatches(input: { userId: string; periodMonth?: string }): Promise<PreparedBatch[]> {
  return cc.prepareCaBatches(input.userId, input.periodMonth ?? previousMonth(todayIn()));
}

export async function sendPreparedCaBatch(input: { userId: string; batchId: string }): Promise<void> {
  await cc.sendCaBatch(input.userId, input.batchId);
}
