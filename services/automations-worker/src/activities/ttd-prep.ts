import { cc } from "../cc-client.js";

// A10.3 — one activity. Pull due windows, resolve each window's pilgrim pack
// for its owning user, Slack a reminder, then bulk-mark notified. The
// catalog is explicit that we do NOT auto-book; this just prepares the user.

const TTD_ALERT_ROUTE = process.env.TTD_ALERT_ROUTE_KEY ?? "automations.digest";
const TTD_BOOKING_URL = process.env.TTD_BOOKING_URL ?? "https://ttdevasthanams.ap.gov.in/";

const SLOT_LABEL: Record<string, string> = {
  ssd: "SSD (Sarva Darshan)",
  vip_break: "VIP Break Darshan",
  suprabhatam: "Suprabhatam Seva",
  archana: "Archana",
  kalyanam: "Kalyanam",
  other: "Other",
};

function istFormat(iso: string): string {
  // Example: "Mon 26 Oct 2026, 10:00 IST"
  const d = new Date(iso);
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "short", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d) + " IST"
  );
}

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

function formatPilgrim(p: {
  fullName: string; relationship: string; idType: string | null;
  pii: { idNumber?: string; dob?: string; phone?: string };
}): string {
  const bits: string[] = [p.fullName, `(${p.relationship}`];
  if (p.idType && p.pii.idNumber) bits.push(`${p.idType} ${p.pii.idNumber}`);
  else if (p.idType) bits.push(p.idType);
  if (p.pii.dob) bits.push(`dob ${p.pii.dob}`);
  if (p.pii.phone) bits.push(p.pii.phone);
  // Join the context pieces inside the parens, then close.
  return `${bits[0]} ${bits[1]}, ${bits.slice(2).join(", ")})`.replace(/, \)/, ")");
}

export async function prepareTtdReminders(args: { withinHours?: number; renotifyHours?: number } = {}): Promise<{
  due: number;
  notified: number;
  failed: number;
}> {
  const due = await cc.dueTtdWindows(args.withinHours ?? 48, args.renotifyHours ?? 24);
  if (due.length === 0) return { due: 0, notified: 0, failed: 0 };

  // Group windows by userId so we fetch each user's pilgrim pack once.
  const byUser = new Map<string, typeof due>();
  for (const w of due) {
    const list = byUser.get(w.userId) ?? [];
    list.push(w);
    byUser.set(w.userId, list);
  }

  const notifiedIds: string[] = [];
  let failed = 0;

  for (const [userId, windows] of byUser) {
    // Union of all pilgrim ids referenced across this user's windows → one lookup.
    const allIds = Array.from(new Set(windows.flatMap((w) => w.pilgrimIds)));
    let pilgrims: Awaited<ReturnType<typeof cc.pilgrimsForUser>> = [];
    try {
      pilgrims = allIds.length ? await cc.pilgrimsForUser(userId, allIds) : [];
    } catch (err) {
      console.warn("[ttd-prep] pilgrim fetch failed", { userId, err: String(err) });
      failed += windows.length;
      continue;
    }
    const pilgrimById = new Map(pilgrims.map((p) => [p.id, p]));

    for (const w of windows) {
      try {
        const names = w.pilgrimIds
          .map((id) => pilgrimById.get(id))
          .filter((p): p is NonNullable<typeof p> => !!p);
        const header = `🛕 *TTD booking opens ${humanDelta(w.releaseAt)}*`;
        const line1  = `*Date:* ${w.darshanDate} · ${SLOT_LABEL[w.slotType] ?? w.slotType}`;
        const line2  = `*Opens:* ${istFormat(w.releaseAt)}`;
        const roster = names.length
          ? `*Pilgrims (${names.length}):*\n` + names.map((p) => `• ${formatPilgrim(p)}`).join("\n")
          : `_No pilgrims attached to this window yet._`;
        const noteLn = w.note ? `*Note:* ${w.note}` : "";
        const foot   = `Book at: ${TTD_BOOKING_URL}`;
        const text   = [header, line1, line2, "", roster, noteLn, "", foot].filter(Boolean).join("\n");

        await cc.notify(TTD_ALERT_ROUTE, text);
        notifiedIds.push(w.windowId);
      } catch (err) {
        console.warn("[ttd-prep] notify failed", { windowId: w.windowId, err: String(err) });
        failed++;
      }
    }
  }

  if (notifiedIds.length) {
    try { await cc.markTtdWindowsNotified(notifiedIds); }
    catch (err) { console.warn("[ttd-prep] mark notified failed", { err: String(err) }); }
  }

  return { due: due.length, notified: notifiedIds.length, failed };
}
