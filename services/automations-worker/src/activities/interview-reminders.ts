import { cc } from "../cc-client.js";

// A4 — every 15 min, scan upcoming rounds in the next 24h and Slack a
// one-line nudge per round that hasn't been pinged in the renotify window
// (default 24h, so you get at most one ping per round).

const INTERVIEW_ROUTE = process.env.INTERVIEW_ALERT_ROUTE_KEY ?? "automations.digest";

const KIND_LABEL: Record<string, string> = {
  phone_screen: "Phone screen", technical: "Technical", system_design: "System design",
  behavioral: "Behavioral", onsite: "Onsite", bar_raiser: "Bar raiser", other: "Interview",
};

function humanDelta(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600_000);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rem = h % 24;
    return rem ? `in ${d}d ${rem}h` : `in ${d}d`;
  }
  if (h >= 1) {
    const m = Math.floor((ms % 3600_000) / 60_000);
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  return `in ${Math.ceil(ms / 60_000)}m`;
}

function istFormat(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d) + " IST";
}

export async function remindUpcomingInterviewRounds(input: {
  withinHours?: number;
  renotifyHours?: number;
  routeKey?: string;
} = {}): Promise<{ due: number; notified: number; failed: number }> {
  const rounds = await cc.dueInterviewRounds(input.withinHours ?? 24, input.renotifyHours ?? 24);
  if (rounds.length === 0) return { due: 0, notified: 0, failed: 0 };

  const route = input.routeKey ?? INTERVIEW_ROUTE;
  const notified: string[] = [];
  let failed = 0;
  for (const r of rounds) {
    const header = `🗓️ *Interview coming up — ${humanDelta(r.scheduledAt)}*`;
    const line1 = `*${r.company}* · ${r.role}`;
    const line2 = `*${KIND_LABEL[r.kind] ?? r.kind}* at ${istFormat(r.scheduledAt)}${r.durationMin ? ` (${r.durationMin}m)` : ""}${r.interviewer ? ` · with ${r.interviewer}` : ""}`;
    const noteLn = r.notes ? `_${r.notes}_` : "";
    const text = [header, line1, line2, noteLn].filter(Boolean).join("\n");
    try {
      await cc.notify(route, text);
      notified.push(r.roundId);
    } catch (err) {
      console.warn("[a4.reminders] notify failed", { roundId: r.roundId, err: String(err) });
      failed++;
    }
  }
  if (notified.length) {
    try { await cc.markInterviewRoundsNotified(notified); }
    catch (err) { console.warn("[a4.reminders] mark notified failed", { err: String(err) }); }
  }
  return { due: rounds.length, notified: notified.length, failed };
}
