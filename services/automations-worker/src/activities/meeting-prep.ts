import { cc } from "../cc-client.js";
import { calendarClient } from "../google-oauth.js";

// N13 — meeting prep, local context only. Runs every 30 minutes per pinned
// account and covers meetings starting 30–60 minutes ahead, so each meeting
// gets exactly one note with no stored state. Solo blocks are skipped.

export const WINDOW_START_MIN = 30;
export const WINDOW_END_MIN = 60;
const MAX_ATTENDEES = 6;

export interface MeetingEvent {
  id: string;
  summary: string;
  start: string;            // ISO date-time
  attendees: string[];      // other people (self excluded)
  link: string | null;      // Meet / video link
  location: string | null;
}

export interface PrepContext {
  notes: Array<{ title: string; type: string; createdOn: string }>;
  session: { company: string; role: string } | null;
}

/** Pure: which interview session (if any) this meeting is about. */
export function matchSession(summary: string, sessions: Array<{ company: string; role: string }>) {
  const s = summary.toLowerCase();
  return sessions.find((x) => x.company.trim().length >= 3 && s.includes(x.company.trim().toLowerCase())) ?? null;
}

export function formatMeetingPrep(e: MeetingEvent, ctx: PrepContext, tz = "Asia/Kolkata"): string {
  const time = new Date(e.start).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  const people = e.attendees.length > MAX_ATTENDEES
    ? `${e.attendees.slice(0, MAX_ATTENDEES).join(", ")} +${e.attendees.length - MAX_ATTENDEES} more`
    : e.attendees.join(", ");
  const lines = [`*Up next at ${time}: ${e.summary}*`, `With: ${people}`];
  if (e.link) lines.push(`Join: ${e.link}`);
  else if (e.location) lines.push(`Where: ${e.location}`);
  if (ctx.session) lines.push(`Interview: ${ctx.session.company} · ${ctx.session.role} — prep notes are on the Interviews page`);
  if (ctx.notes.length) {
    lines.push("Your related notes:");
    for (const n of ctx.notes) lines.push(`• ${n.title} (${n.type}, ${n.createdOn})`);
  }
  return lines.join("\n");
}

export async function buildMeetingPrep(input: { userId: string; userEmail: string; routeKey: string }) {
  const cal = await calendarClient(input.userEmail);
  const now = Date.now();
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: new Date(now + WINDOW_START_MIN * 60_000).toISOString(),
    timeMax: new Date(now + WINDOW_END_MIN * 60_000).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 10,
  });

  const events: MeetingEvent[] = (res.data.items ?? [])
    .filter((e) => e.start?.dateTime && e.status !== "cancelled")
    // timeMin/timeMax also return events already in progress; keep only starts inside the window.
    .filter((e) => new Date(e.start!.dateTime!).getTime() >= now + WINDOW_START_MIN * 60_000)
    .map((e) => ({
      id: e.id ?? "",
      summary: e.summary ?? "(no title)",
      start: e.start!.dateTime!,
      attendees: (e.attendees ?? [])
        .filter((a) => !a.self && !a.resource && a.responseStatus !== "declined")
        .map((a) => a.displayName || a.email || "")
        .filter(Boolean),
      link: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null,
      location: e.location ?? null,
    }))
    .filter((e) => e.attendees.length > 0); // solo blocks ("Focus", reminders) aren't meetings

  if (events.length === 0) return { posted: 0 };
  const sessions = await cc.listInterviewSessions(input.userId).catch(() => []);
  for (const e of events) {
    const notes = await cc.searchKnowledgeItems(input.userId, e.summary, 3).catch(() => []);
    await cc.notify(input.routeKey, formatMeetingPrep(e, { notes, session: matchSession(e.summary, sessions) }, process.env.SCHEDULE_TIMEZONE ?? "Asia/Kolkata"));
  }
  return { posted: events.length };
}
