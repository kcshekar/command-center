import { cc } from "../cc-client.js";
import { gmailClient } from "../google-oauth.js";
import { ollamaJson, ollamaText } from "../ollama.js";

// A5.1 — dispatchers invoked from the inbox-triage workflow when the
// classifier labels a message `job_posting` or `needs_reply`.
//
//   job_posting   → create a job_lead in A2's table from the email itself.
//                   The source is "mail:<messageId>" so the row stays
//                   idempotent across reruns of the same sweep.
//   needs_reply   → kicks off the mailReplyWorkflow (A5.2) as a child
//                   workflow from inbox-triage itself.
//
// A5.2 — reply drafter + Gmail send. Fetch full body, Ollama drafts a
// response, Slack approval card gates the send.

const DEFAULT_REPLY_DRAFTER_PROMPT = `You draft a short, polite email reply on behalf of a senior developer.

Given the inbound email (from, subject, body), produce a reply that:
- opens with a one-line acknowledgement
- answers or responds in 2-5 short sentences
- ends with a natural sign-off (just "Thanks," on its own line — the sender's name is appended by the system)

Rules:
- plain text only, no markdown, no emoji
- do NOT invent facts, dates, or commitments not in the inbound
- if the inbound asks something you can't answer from its content alone, write a short "let me check and get back to you" reply
- Return ONLY the reply body (no subject, no "To:", no signature block beyond "Thanks,").`;

// Rough first-URL extractor — picks the first http(s) link in the snippet.
// Most job alerts open with "View job: https://…" or "Apply: https://…"
// so this is usually good enough.
function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}

export async function ingestJobEmailLead(
  userId: string,
  email: { id: string; subject: string; snippet: string; from: string }
): Promise<{ ok: boolean; reason?: string }> {
  const url = firstUrl(email.snippet) ?? firstUrl(email.subject);
  if (!url) return { ok: false, reason: "no url in snippet" };

  try {
    await cc.upsertJobLead({
      userId,
      source: "mail",
      sourceId: email.id,
      title: email.subject.slice(0, 200) || "(no subject)",
      url,
      company: null,
      location: null,
      description: email.snippet.slice(0, 800),
      metadata: {
        via: "a5.mail",
        emailFrom: email.from,
        emailId: email.id,
      },
    });
    return { ok: true };
  } catch (err) {
    console.warn("[a5.mail] job_posting ingest failed", { emailId: email.id, err: String(err) });
    return { ok: false, reason: String(err).slice(0, 160) };
  }
}

// A5 — extract interview details from the email body + upsert a session+round.
// Fully best-effort: if the LLM can't pin a time, we skip the round (session
// still created so the UI shows it). Rounds go through the calendar-upsert
// path with a mail: pseudo-id so the same email doesn't duplicate.

const INTERVIEW_EXTRACT_SCHEMA = {
  type: "object",
  required: ["company"],
  properties: {
    company:      { type: "string" },
    role:         { type: ["string", "null"] },
    scheduledAt:  { type: ["string", "null"] },   // ISO 8601
    durationMin:  { type: ["integer", "null"] },
    kind:         { type: ["string", "null"], enum: ["phone_screen","technical","system_design","behavioral","onsite","bar_raiser","other", null] },
    interviewer:  { type: ["string", "null"] },
  },
} as const;

export async function ingestInterviewSchedulingEmail(
  userId: string,
  userEmail: string,
  email: { id: string; subject: string; snippet: string; from: string }
): Promise<{ ok: boolean; sessionId?: string; roundId?: string; reason?: string }> {
  let bodyText = email.snippet;
  // Fetch full body — snippets drop critical scheduling detail.
  try {
    const full = await fetchGmailMessageFull(userEmail, email.id);
    if (full.body) bodyText = full.body;
  } catch { /* snippet-only is still workable */ }

  const prompt = `You extract interview scheduling fields from an email. Return JSON matching the schema. Rules:
- scheduledAt: ISO-8601 timestamp with timezone. If only a date (no time), use the date at 10:00 in the sender's apparent timezone. If no scheduling info at all, use null.
- durationMin: integer minutes, null if not stated.
- kind: one of 'phone_screen'|'technical'|'system_design'|'behavioral'|'onsite'|'bar_raiser'|'other' (infer from title/duration/wording), null if truly unclear.
- company: your best guess from the sender domain or signature.
- role: the role title if mentioned; null otherwise.
- interviewer: the sender's name if the email is from a human, else null.
Return ONLY the JSON.

Email:
from: ${email.from}
subject: ${email.subject}
body:
${bodyText.slice(0, 3000)}`;

  let parsed: {
    company?: string; role?: string | null; scheduledAt?: string | null;
    durationMin?: number | null; kind?: string | null; interviewer?: string | null;
  };
  try {
    parsed = await ollamaJson(prompt, INTERVIEW_EXTRACT_SCHEMA);
  } catch (err) {
    return { ok: false, reason: `extract failed: ${String(err).slice(0, 120)}` };
  }
  if (!parsed.company || !parsed.company.trim()) {
    return { ok: false, reason: "no company extracted" };
  }
  const role = parsed.role && parsed.role.trim() ? parsed.role.trim() : "(role TBD)";

  const session = await cc.upsertInterviewSession({
    userId,
    company: parsed.company.trim(),
    role,
    notes: `Scheduled from email · ${email.subject}`,
    metadata: { via: "a5.mail", emailId: email.id, emailFrom: email.from },
  });

  // No scheduled time → session only, no round.
  if (!parsed.scheduledAt) {
    return { ok: true, sessionId: session.id, reason: "no scheduledAt extracted; session only" };
  }
  const scheduledIso = new Date(parsed.scheduledAt).toISOString();
  if (Number.isNaN(new Date(scheduledIso).getTime())) {
    return { ok: true, sessionId: session.id, reason: "invalid scheduledAt; session only" };
  }

  try {
    const r = await cc.upsertCalendarInterviewRound({
      userId,
      sessionId: session.id,
      // Reuse the calendar upsert path for idempotency — the "event id" is
      // the mail message id namespaced under "mail:" so a real Google Cal
      // sync can't collide.
      calendarEventId: `mail:${email.id}`,
      kind: parsed.kind ?? "other",
      scheduledAt: scheduledIso,
      durationMin: parsed.durationMin ?? undefined,
      interviewer: parsed.interviewer ?? undefined,
      notes: email.subject,
    });
    return { ok: true, sessionId: session.id, roundId: r.id };
  } catch (err) {
    return { ok: true, sessionId: session.id, reason: `round upsert failed: ${String(err).slice(0, 120)}` };
  }
}

export async function logReplyNeeded(
  email: { id: string; subject: string; from: string }
): Promise<{ ok: boolean }> {
  // Kept for backward-compat during the A5.1 → A5.2 cutover; the workflow
  // now spawns mailReplyWorkflow directly, so this is a soft log.
  console.log("[a5.mail] needs_reply dispatched to child workflow", {
    emailId: email.id, from: email.from, subject: email.subject,
  });
  return { ok: true };
}

// A5.2 — pull the full body of a message. Prefers plain text; falls back to
// HTML stripped of tags for a decent-ish fallback. Snippets alone aren't
// enough context for the drafter.
export async function fetchGmailMessageFull(
  userEmail: string,
  messageId: string
): Promise<{ subject: string; from: string; to: string; body: string; threadId: string; messageIdHeader: string | null }> {
  const gmail = await gmailClient(userEmail);
  const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = msg.data.payload?.headers ?? [];
  const h = (name: string) => headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  const parts = flattenParts(msg.data.payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  const data = plain?.body?.data ?? html?.body?.data ?? msg.data.payload?.body?.data ?? "";
  let body = Buffer.from(data, "base64url").toString("utf8");
  if (!plain && html) {
    // Very lightweight tag strip; a real-world setup would use a parser.
    body = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return {
    subject: h("Subject"),
    from: h("From"),
    to: h("To"),
    body: body.slice(0, 4000),            // cap for the LLM context
    threadId: msg.data.threadId ?? "",
    messageIdHeader: h("Message-ID") || null,
  };
}

function flattenParts(p: any): any[] {
  if (!p) return [];
  const out: any[] = [p];
  if (p.parts) for (const c of p.parts) out.push(...flattenParts(c));
  return out;
}

// A5.2 — one Ollama call, free-form text out. Prompt resolution: user override
// → org default → hardcoded fallback.
export async function draftReplyToEmail(input: {
  userId: string;
  fullBody: string;
  subject: string;
  from: string;
}): Promise<{ reply: string }> {
  const prompt = (await cc.getEffectivePrompt("mail_reply_drafter", input.userId))?.body
    ?? DEFAULT_REPLY_DRAFTER_PROMPT;

  const full = `${prompt}

Return ONLY the reply body.

Inbound:
from: ${input.from}
subject: ${input.subject}
body:
${input.fullBody}`;

  const reply = (await ollamaText(full, { temperature: 0.4 })).trim();
  return { reply };
}

// A5.2 — Gmail send. Builds a minimal RFC-5322 message with In-Reply-To +
// References so Gmail threads the reply. On success returns the sent id so
// the workflow can audit it; on failure throws (workflow catches).
export async function sendGmailReply(input: {
  userEmail: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
}): Promise<{ sentId: string }> {
  const gmail = await gmailClient(input.userEmail);
  const subject = input.subject.toLowerCase().startsWith("re:") ? input.subject : `Re: ${input.subject}`;
  const lines = [
    `To: ${input.to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `MIME-Version: 1.0`,
  ];
  if (input.inReplyTo) {
    lines.push(`In-Reply-To: ${input.inReplyTo}`);
    lines.push(`References: ${input.inReplyTo}`);
  }
  lines.push("");
  lines.push(input.body);
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: input.threadId || undefined },
  });
  return { sentId: sent.data.id ?? "" };
}
