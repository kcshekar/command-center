"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { lifeApi, type TravelBooking } from "@/lib/life-api";

// R14 — bookings Mail dispatcher found in Gmail. The full booking reference is
// shown only here; the Slack trip pack masks it.

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function TravelPage() {
  const [trips, setTrips] = useState<TravelBooking[] | null>(null);

  async function refresh() {
    try { setTrips(await lifeApi.trips()); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not load trips")); setTrips([]); }
  }
  useEffect(() => { void refresh(); }, []);

  async function remove(t: TravelBooking) {
    try { await lifeApi.deleteTrip(t.id); await refresh(); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not remove")); }
  }

  const now = Date.now();
  const upcoming = (trips ?? []).filter((t) => Date.parse(t.depart_at) >= now);
  const past = (trips ?? []).filter((t) => Date.parse(t.depart_at) < now);

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Trips</h1>
        <p className="text-sm text-muted-foreground">
          Flight, train, bus and hotel bookings found in your Gmail by{" "}
          <Link href="/automations/a5.mail" className="font-medium text-primary">Mail dispatcher</Link>. A day before you leave,{" "}
          <Link href="/automations/r14.travel" className="font-medium text-primary">Trip pack</Link> sends the details.
        </p>
      </div>
      {trips === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : upcoming.length === 0 ? (
        <p className="text-sm text-muted-foreground">No upcoming trips. Booking confirmations land here as they arrive in your inbox.</p>
      ) : (
        <TripList trips={upcoming} onRemove={remove} />
      )}
      {past.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last 30 days</h2>
          <TripList trips={past} onRemove={remove} />
        </section>
      )}
    </div>
  );
}

function TripList({ trips, onRemove }: { trips: TravelBooking[]; onRemove: (t: TravelBooking) => void }) {
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {trips.map((t) => (
        <li key={t.id} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
          <span className="w-16 shrink-0 pt-0.5 font-mono text-[11px] uppercase text-muted-foreground">{t.kind}</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium [overflow-wrap:anywhere]">
              {t.kind === "hotel" ? t.to_place ?? t.provider ?? "Hotel" : [t.from_place, t.to_place].filter(Boolean).join(" → ") || t.provider || "Trip"}
            </div>
            <div className="text-xs text-muted-foreground">
              {when(t.depart_at)}{t.end_at ? ` → ${when(t.end_at)}` : ""}{t.provider ? ` · ${t.provider}` : ""}
            </div>
            {t.reference && <div className="mt-0.5 font-mono text-xs">Ref {t.reference}</div>}
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onRemove(t)}>Remove</Button>
        </li>
      ))}
    </ul>
  );
}
