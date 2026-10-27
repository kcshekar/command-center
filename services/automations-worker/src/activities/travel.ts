import { cc } from "../cc-client.js";
import { ollamaJson } from "../ollama.js";
import { fetchGmailMessageFull } from "./mail-dispatch.js";

// R14 — travel bookings. Mail dispatcher recognises a booking email with the
// deterministic parsers/travel.ts check; here the LOCAL model pulls out the
// details from the full body, validated hard (a wrong date is worse than no
// booking). A day before departure the trip pack goes out with the booking
// reference masked — the full reference stays in the app.

const EXTRACT_SCHEMA = {
  type: "object",
  required: ["kind", "departAt"],
  properties: {
    kind: { type: "string", enum: ["flight", "train", "bus", "hotel", "other"] },
    provider: { type: ["string", "null"] },
    reference: { type: ["string", "null"] },
    from: { type: ["string", "null"] },
    to: { type: ["string", "null"] },
    departAt: { type: ["string", "null"] },
    endAt: { type: ["string", "null"] },
  },
} as const;

export interface TripBooking {
  kind: "flight" | "train" | "bus" | "hotel" | "other";
  provider: string | null;
  reference: string | null;
  from: string | null;
  to: string | null;
  departAt: string;
  endAt: string | null;
}

/** "ABC12D" → "••••2D": enough to recognise, not enough to use. */
export function maskReference(ref: string | null): string | null {
  if (!ref) return null;
  const r = ref.trim();
  return r.length <= 2 ? "••" : `••••${r.slice(-2)}`;
}

export function formatTripPack(trips: TripBooking[], tz = "Asia/Kolkata"): string | null {
  if (trips.length === 0) return null;
  const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz });
  const lines = ["🧳 *Trip pack — leaving in about 24 hours*"];
  for (const t of trips) {
    const route = t.kind === "hotel" ? (t.to ?? t.provider ?? "Hotel") : [t.from, t.to].filter(Boolean).join(" → ") || "Trip";
    lines.push("", `*${t.kind === "hotel" ? "Hotel" : t.kind.charAt(0).toUpperCase() + t.kind.slice(1)}: ${route}*`);
    lines.push(`${t.kind === "hotel" ? "Check-in" : "Departs"} ${when(t.departAt)}${t.endAt ? ` · ${t.kind === "hotel" ? "check-out" : "arrives"} ${when(t.endAt)}` : ""}`);
    const ref = maskReference(t.reference);
    if (t.provider || ref) lines.push([t.provider, ref ? `ref ${ref} (full on the Trips page)` : null].filter(Boolean).join(" · "));
  }
  return lines.join("\n");
}

export async function ingestTravelBookingEmail(
  userId: string,
  userEmail: string,
  email: { id: string; subject: string; snippet: string; from: string },
): Promise<{ ok: boolean; reason?: string }> {
  let body = email.snippet;
  try {
    const full = await fetchGmailMessageFull(userEmail, email.id);
    if (full.body) body = full.body;
  } catch { /* snippet still has the basics */ }

  const parsed = (await ollamaJson(
    `Extract the travel booking from this confirmation email. Return JSON matching the schema.
- kind: flight | train | bus | hotel | other
- provider: airline / railway / hotel / agency name
- reference: the PNR or booking reference exactly as written, else null
- from, to: origin and destination city or station (for a hotel: from = null, to = hotel name and city)
- departAt: departure (or hotel check-in) as ISO-8601 with timezone offset; assume +05:30 if the email gives no zone
- endAt: arrival (or check-out) the same way, else null
Do not invent anything; use null when a field is not in the email.

from: ${email.from}
subject: ${email.subject}
body:
${body.slice(0, 3500)}`,
    EXTRACT_SCHEMA,
  )) as Partial<TripBooking>;

  const depart = parsed.departAt ? Date.parse(parsed.departAt) : NaN;
  // Sanity window: a booking email is about a trip from a week ago to 18 months out.
  if (Number.isNaN(depart) || depart < Date.now() - 7 * 86_400_000 || depart > Date.now() + 550 * 86_400_000) {
    return { ok: false, reason: "no usable departure date" };
  }
  await cc.upsertTravelBooking({
    userId,
    sourceMessageId: email.id,
    kind: parsed.kind ?? "other",
    provider: parsed.provider ?? null,
    reference: parsed.reference ?? null,
    from: parsed.from ?? null,
    to: parsed.to ?? null,
    departAt: new Date(depart).toISOString(),
    endAt: parsed.endAt && !Number.isNaN(Date.parse(parsed.endAt)) ? new Date(parsed.endAt).toISOString() : null,
  });
  return { ok: true };
}

export async function buildTripPack(input: { userId: string; routeKey: string }) {
  const now = Date.now();
  // Hourly schedule + a one-hour window 23–24h ahead → each trip once.
  const trips = await cc.departingTrips(input.userId, new Date(now + 23 * 3_600_000).toISOString(), new Date(now + 24 * 3_600_000).toISOString());
  const text = formatTripPack(trips, process.env.SCHEDULE_TIMEZONE ?? "Asia/Kolkata");
  if (!text) return { posted: false };
  await cc.notify(input.routeKey, text);
  return { posted: true, trips: trips.length };
}
