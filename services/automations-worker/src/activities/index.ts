import { pool } from "../db.js";
import { gmailClient, calendarClient, tasksClient } from "../google-oauth.js";
import { cc, type DueReminder, type PostedRef } from "../cc-client.js";
import { classifyEmail, extractExpense, extractBill, type Classification } from "../ollama.js";
import { parseExpenseEmail, type EmailInput } from "../parsers/index.js";

export { fetchInitialPriceSnapshot, listDuePriceWatches } from "./price-watch.js";
export { prepareTtdReminders } from "./ttd-prep.js";
export { ingestHnTopStories, classifyNewsItem, draftAndPostNewsBrief } from "./news.js";
export { ingestLearningReleases, classifyLessonItem, draftAndPostLearningDigest } from "./learning.js";
export { scanRepoDepUpgrades } from "./upgrader.js";
export { ingestAdzunaJobs, draftAndPostJobsDigest } from "./jobs.js";
export { refreshProfileDrafts } from "./profile-refresh.js";
export { ingestJobEmailLead, logReplyNeeded, fetchGmailMessageFull, draftReplyToEmail, sendGmailReply, ingestInterviewSchedulingEmail } from "./mail-dispatch.js";
export { researchJobLeadForInterview } from "./interview-prep.js";
export { tailorResumeForJobLead } from "./resume-tailor.js";
export { remindUpcomingInterviewRounds } from "./interview-reminders.js";
export { syncGoogleCalendarInterviews } from "./calendar-sync.js";
export { sweepUnembeddedKnowledgeItems } from "./embedder.js";
export { openGithubPrFromKnowledgeItem } from "./github-pr.js";
export { buildDailySpendReport } from "./spend-report.js";
export { buildSubscriptionsReport, buildBillForecast, buildBudgetReport, buildNetWorthReport } from "./money-reports.js";
export { buildDocumentExpiryReport } from "./doc-expiry.js";
export { buildLearningCheck } from "./learning-check.js";
export { buildOccasionsReport } from "./occasions.js";
export { fetchWeatherBrief, draftAffirmation } from "./morning-extras.js";
export { buildHabitCheckin, buildGroceryList, buildVehicleReport } from "./life-reports.js";
export { buildMeetingPrep } from "./meeting-prep.js";
export { ingestTravelBookingEmail, buildTripPack } from "./travel.js";
export { prepareCaBatches, sendPreparedCaBatch } from "./ca-invoices.js";
export { scanDependencyVulns } from "./security-scan.js";
export { retrieveKnowledgeContext } from "./knowledge-rag.js";

// ─── Google reads ────────────────────────────────────────────────────────────

export async function fetchCalendarEvents(userEmail: string, hours = 24): Promise<Array<{ start: string; end: string; summary: string }>> {
  const cal = await calendarClient(userEmail);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return (res.data.items ?? []).map((e) => ({
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    summary: e.summary ?? "(no title)",
  }));
}

export async function fetchGoogleTasks(userEmail: string): Promise<Array<{ title: string; due: string | null }>> {
  const tasks = await tasksClient(userEmail);
  const lists = await tasks.tasklists.list();
  const out: Array<{ title: string; due: string | null }> = [];
  for (const list of lists.data.items ?? []) {
    const items = await tasks.tasks.list({ tasklist: list.id!, showCompleted: false, maxResults: 100 });
    for (const t of items.data.items ?? []) {
      if (t.status !== "completed") out.push({ title: t.title ?? "(untitled)", due: t.due ?? null });
    }
  }
  return out;
}

// ─── Gmail ingest ────────────────────────────────────────────────────────────

// Polling-mode ingest (D-simplification): reads new messages since our stored
// historyId and returns the delta plus the historyId to advance to. The
// cursor is NOT moved here — the workflow calls commitGmailCursor only after
// every message is classified/ingested, so an Ollama outage replays the batch
// on the next tick instead of silently dropping it.
// ponytail: polling, add push subscription if latency ever matters.
export async function fetchGmailHistory(
  userEmail: string,
  fallbackLookbackHours = 2
): Promise<{ messages: Array<{ id: string; threadId: string; subject: string; from: string; snippet: string }>; historyId: string }> {
  const gmail = await gmailClient(userEmail);

  const cursorRes = await pool.query(
    `SELECT last_history_id FROM gmail_history_cursors WHERE user_email = $1`,
    [userEmail]
  );
  const cursor = cursorRes.rows[0]?.last_history_id as string | undefined;

  let messageIds: string[] = [];
  let newHistoryId: string | undefined;

  if (cursor) {
    try {
      const hist = await gmail.users.history.list({
        userId: "me",
        startHistoryId: cursor,
        historyTypes: ["messageAdded"],
        labelId: "INBOX",
      });
      newHistoryId = hist.data.historyId ?? cursor;
      messageIds = (hist.data.history ?? [])
        .flatMap((h) => h.messagesAdded ?? [])
        .map((m) => m.message?.id)
        .filter((id): id is string => !!id);
    } catch (err: any) {
      // 404 means the cursor is too old; fall through to full lookback.
      if (err?.code !== 404) throw err;
    }
  }

  if (!cursor || !newHistoryId) {
    const after = Math.floor((Date.now() - fallbackLookbackHours * 3600 * 1000) / 1000);
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: `in:inbox after:${after}`,
      maxResults: 25,
    });
    messageIds = (listRes.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    const profile = await gmail.users.getProfile({ userId: "me" });
    newHistoryId = profile.data.historyId!;
  }

  const messages: Array<{ id: string; threadId: string; subject: string; from: string; snippet: string }> = [];
  for (const id of messageIds) {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["Subject", "From"] });
    const headers = msg.data.payload?.headers ?? [];
    messages.push({
      id,
      threadId: msg.data.threadId ?? "",
      subject: headers.find((h) => h.name === "Subject")?.value ?? "",
      from: headers.find((h) => h.name === "From")?.value ?? "",
      snippet: msg.data.snippet ?? "",
    });
  }

  return { messages, historyId: String(newHistoryId) };
}

export async function commitGmailCursor(userEmail: string, historyId: string): Promise<void> {
  await pool.query(
    `INSERT INTO gmail_history_cursors (user_email, last_history_id, last_synced_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_email) DO UPDATE SET last_history_id = EXCLUDED.last_history_id, last_synced_at = now()`,
    [userEmail, historyId]
  );
}

// ─── LLM ──────────────────────────────────────────────────────────────────────

// Malformed model output for one message → null (stays "unclassified").
// Transport errors (Ollama unreachable, 5xx) throw so the triage run fails
// before committing the Gmail cursor and the batch is retried next tick.
export async function classifyEmailOllama(
  input: { subject: string; snippet: string; from: string }
): Promise<Classification | null> {
  try {
    return await classifyEmail(input.subject, input.snippet, input.from);
  } catch (err) {
    if (err instanceof SyntaxError || /invalid category/.test(String(err))) return null;
    throw err;
  }
}

// ─── Command Center ──────────────────────────────────────────────────────────

export async function fetchCCDueReminders(days = 7, userId?: string): Promise<DueReminder[]> {
  return cc.dueReminders(days, userId);
}

export async function postNotification(routeKey: string, text: string): Promise<void> {
  await cc.notify(routeKey, text);
}

export async function postApprovalNotification(
  routeKey: string,
  text: string,
  blocks: unknown[],
  workflowId: string,
  actionId: string
): Promise<PostedRef[]> {
  return cc.notifyApproval(routeKey, text, blocks, workflowId, actionId);
}

// Called once per approval, after it is settled. `approvalState` also settles
// the in-app copy so Today/Inbox stop listing it as pending (Slack-side clicks
// and 24h expiry never touched the in-app row before).
export async function updateApprovalNotification(
  routeKey: string,
  refs: PostedRef[],
  text: string,
  approvalState?: "approved" | "rejected" | "expired"
): Promise<void> {
  await cc.updateNotification(routeKey, refs, text, [
    { type: "section", text: { type: "mrkdwn", text } },
  ], approvalState);
}

// ─── Gmail mutations (Phase 4) ────────────────────────────────────────────
// gmail.modify scope, `trash` (not `delete`) — recoverable, matches doc §4.

export async function trashGmailMessages(userEmail: string, messageIds: string[]): Promise<{ trashed: number }> {
  if (messageIds.length === 0) return { trashed: 0 };
  const gmail = await gmailClient(userEmail);
  for (const id of messageIds) {
    await gmail.users.messages.trash({ userId: "me", id });
  }
  return { trashed: messageIds.length };
}

// ─── Phase 5: finance ingestion ─────────────────────────────────────────────

// Runs deterministic parsers first; only falls back to Ollama if none match.
// Posts to CC with source='gmail' + externalId=messageId so replays are
// idempotent. Returns {ok, via} for the caller to log.
export async function ingestExpenseFromEmail(
  messageId: string,
  email: EmailInput,
  owner?: { userId: string; zone: "personal" | "professional" }
): Promise<{ ok: boolean; via: "deterministic" | "ollama" | "none"; parser?: string }> {
  const det = parseExpenseEmail(email);
  if (det) {
    await cc.createExpense({
      accountName: det.expense.accountName,
      amountCents: det.expense.amountCents,
      currency: det.expense.currency,
      category: det.expense.category,
      occurredOn: det.expense.occurredOn,
      source: "gmail",
      externalId: messageId,
      note: `Parsed by ${det.parser}`,
      ...owner,
    });
    return { ok: true, via: "deterministic", parser: det.parser };
  }

  const llm = await extractExpense(email.subject, email.snippet, email.from);
  if (!llm) return { ok: false, via: "none" };

  await cc.createExpense({
    accountName: llm.accountName,
    amountCents: llm.amountCents,
    currency: llm.currency,
    category: llm.category,
    occurredOn: llm.occurredOn,
    source: "gmail",
    externalId: messageId,
    note: `Parsed by Ollama (confidence ${llm.confidence.toFixed(2)})`,
    ...owner,
  });
  return { ok: true, via: "ollama" };
}

export async function ingestBillReminder(
  messageId: string,
  email: EmailInput,
  userId?: string
): Promise<{ ok: boolean }> {
  const bill = await extractBill(email.subject, email.snippet, email.from);
  if (!bill) return { ok: false };
  await cc.createReminder({
    title: bill.title + (bill.amountCents ? ` — ₹${(bill.amountCents / 100).toFixed(0)}` : ""),
    category: "bill",
    dueOn: bill.dueOn,
    source: "gmail",
    externalId: `bill-${messageId}`,
    userId,
  });
  return { ok: true };
}

// ─── Phase 5: evening wrap ──────────────────────────────────────────────────

export async function fetchCompletedTasksToday(userEmail: string): Promise<Array<{ title: string; completed: string }>> {
  const tasks = await tasksClient(userEmail);
  const lists = await tasks.tasklists.list();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const out: Array<{ title: string; completed: string }> = [];
  for (const list of lists.data.items ?? []) {
    const items = await tasks.tasks.list({
      tasklist: list.id!,
      showCompleted: true,
      showHidden: true,
      completedMin: startOfDay.toISOString(),
      maxResults: 100,
    });
    for (const t of items.data.items ?? []) {
      if (t.status === "completed" && t.completed) {
        out.push({ title: t.title ?? "(untitled)", completed: t.completed });
      }
    }
  }
  return out;
}

// Overdue open tasks → move `due` forward one day. Google Tasks stores `due`
// as date-only per D5/Phase 3 note; time-of-day is dropped by the API.
export async function rolloverOverdueTasks(userEmail: string): Promise<Array<{ title: string; from: string; to: string }>> {
  const tasks = await tasksClient(userEmail);
  const lists = await tasks.tasklists.list();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000);
  const tomorrowIso = tomorrow.toISOString();
  const rolled: Array<{ title: string; from: string; to: string }> = [];
  for (const list of lists.data.items ?? []) {
    const items = await tasks.tasks.list({ tasklist: list.id!, showCompleted: false, maxResults: 100 });
    for (const t of items.data.items ?? []) {
      if (t.status === "completed" || !t.due) continue;
      const due = new Date(t.due);
      if (due >= today) continue;
      await tasks.tasks.update({
        tasklist: list.id!,
        task: t.id!,
        requestBody: { ...t, due: tomorrowIso },
      });
      rolled.push({ title: t.title ?? "(untitled)", from: t.due.slice(0, 10), to: tomorrowIso.slice(0, 10) });
    }
  }
  return rolled;
}
