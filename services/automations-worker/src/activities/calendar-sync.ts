import { cc } from "../cc-client.js";
import { calendarClient } from "../google-oauth.js";

// A4 — pull next 30d from Google Calendar, match events to known
// interview_sessions by company name, upsert rounds. Idempotent on
// metadata.calendarEventId so a re-sync doesn't duplicate.
//
// Kind inference: duration + title keywords. Attendees go into interviewer.
// The user can edit kind/notes afterwards; this is seeding.

const KEYWORD_HINTS: Array<[RegExp, string]> = [
  [/system\s*design|systems?\s*design/i,                 "system_design"],
  [/behaviou?ral|behavior|bar\s*raiser|values/i,         "behavioral"],
  [/bar\s*raiser/i,                                      "bar_raiser"],
  [/phone\s*screen|intro\s*call|recruiter\s*call/i,      "phone_screen"],
  [/onsite|on-?site|final\s*round|loop/i,                "onsite"],
  [/technical|coding|pair\s*programming|take-?home/i,    "technical"],
];
function inferKind(summary: string, duration: number | null): string {
  const s = summary.toLowerCase();
  for (const [re, kind] of KEYWORD_HINTS) if (re.test(s)) return kind;
  if (duration && duration <= 30) return "phone_screen";
  if (duration && duration >= 150) return "onsite";
  return "other";
}
function looksLikeInterview(summary: string, description: string): boolean {
  const s = (summary + " " + description).toLowerCase();
  return /interview|screen|loop|hiring|candidate|coding\s*call|pair\s*programming|chat\s*with\s*the\s*team/i.test(s);
}

export async function syncGoogleCalendarInterviews(input: {
  userId: string;
  userEmail: string;
  daysAhead?: number;
}): Promise<{
  scanned: number;
  matched: number;
  created: number;
  updated: number;
  skipped: number;
}> {
  const sessions = await cc.listInterviewSessions(input.userId).catch(() => []);
  if (sessions.length === 0) {
    return { scanned: 0, matched: 0, created: 0, updated: 0, skipped: 0 };
  }
  // Build lowercase company → session lookup once.
  const byCompany = new Map<string, { id: string; company: string; role: string }>();
  for (const s of sessions) byCompany.set(s.company.toLowerCase(), s);

  const cal = await calendarClient(input.userEmail);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + (input.daysAhead ?? 30) * 86400 * 1000).toISOString();
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin, timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 100,
  });
  const events = res.data.items ?? [];

  let matched = 0, created = 0, updated = 0, skipped = 0;
  for (const e of events) {
    const summary = e.summary ?? "";
    const description = e.description ?? "";
    const startIso = e.start?.dateTime ?? null;
    const endIso = e.end?.dateTime ?? null;
    if (!startIso) continue;
    if (!looksLikeInterview(summary, description)) continue;

    // Session match: any known company name whose full word appears in the
    // event summary or description. "Acme" at the start of "Acme — chat".
    const haystack = (summary + " " + description).toLowerCase();
    let session: { id: string; company: string; role: string } | undefined;
    for (const [company, s] of byCompany) {
      if (haystack.includes(company)) { session = s; break; }
    }
    if (!session) { skipped++; continue; }
    matched++;

    const duration = startIso && endIso
      ? Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000)
      : null;
    const kind = inferKind(summary, duration);
    const interviewer = (e.attendees ?? [])
      .filter((a) => a.email && a.email !== input.userEmail && !a.resource)
      .map((a) => a.displayName ?? a.email!)
      .slice(0, 3)
      .join(", ") || null;

    try {
      const r = await cc.upsertCalendarInterviewRound({
        userId: input.userId,
        sessionId: session.id,
        calendarEventId: e.id!,
        kind, scheduledAt: startIso,
        durationMin: duration ?? undefined,
        interviewer: interviewer ?? undefined,
        notes: description ? description.slice(0, 500) : undefined,
      });
      if (r.created) created++; else updated++;
    } catch (err) {
      console.warn("[a4.calendar] upsert failed", { eventId: e.id, err: String(err) });
      skipped++;
    }
  }

  return { scanned: events.length, matched, created, updated, skipped };
}
