"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import { formatCents } from "@/lib/finance-api";
import { resolveAmountInput } from "@/lib/calc";
import { lifeApi, localDay, type Vehicle } from "@/lib/life-api";

// R9 — vehicles with fuel and service logs. Log a fill-up in a few taps at the
// pump; mileage (km/L) is worked out from consecutive full-tank fills. The
// Vehicle tracker automation warns when a service is due.

/** km/L across the visible full-tank fill pairs (logs arrive newest first). */
function mileage(v: Vehicle): number | null {
  const fills = v.logs.filter((l) => l.kind === "fuel").slice().reverse();
  let km = 0, litres = 0;
  for (let i = 1; i < fills.length; i++) {
    const a = fills[i - 1], b = fills[i];
    if (!a.full_tank || !b.full_tank || !b.litres || b.odometer_km <= a.odometer_km) continue;
    km += b.odometer_km - a.odometer_km;
    litres += b.litres;
  }
  return litres > 0 ? km / litres : null;
}

export default function VehiclesPage() {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [newName, setNewName] = useState("");
  const [everyKm, setEveryKm] = useState("");
  const [everyMonths, setEveryMonths] = useState("");

  async function refresh() {
    try { setVehicles(await lifeApi.vehicles()); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not load vehicles")); setVehicles([]); }
  }
  useEffect(() => { void refresh(); }, []);

  async function addVehicle(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await lifeApi.addVehicle({
        name: newName.trim(),
        serviceEveryKm: everyKm ? Number(everyKm) : null,
        serviceEveryMonths: everyMonths ? Number(everyMonths) : null,
      });
      setNewName(""); setEveryKm(""); setEveryMonths("");
      await refresh();
    } catch (err) { toast.error(apiErrorMessage(err, "Could not add vehicle")); }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Vehicles</h1>
        <p className="text-sm text-muted-foreground">
          Log fill-ups and services. Mileage comes from consecutive full-tank fills.{" "}
          <Link href="/automations/r9.vehicle" className="font-medium text-primary">Service reminders</Link>
        </p>
      </div>

      {vehicles?.map((v) => <VehicleCard key={v.id} v={v} onChanged={refresh} />)}
      {vehicles !== null && vehicles.length === 0 && <p className="text-sm text-muted-foreground">Add your bike or car to start logging.</p>}

      <form onSubmit={addVehicle} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[1.5fr_1fr_1fr_auto]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="veh-name">Add a vehicle</Label>
          <Input id="veh-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Activa" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="veh-km">Service every (km)</Label>
          <Input id="veh-km" inputMode="numeric" value={everyKm} onChange={(e) => setEveryKm(e.target.value)} placeholder="3000" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="veh-months">or every (months)</Label>
          <Input id="veh-months" inputMode="numeric" value={everyMonths} onChange={(e) => setEveryMonths(e.target.value)} placeholder="6" />
        </div>
        <Button type="submit" className="self-end">Add</Button>
      </form>
    </div>
  );
}

function VehicleCard({ v, onChanged }: { v: Vehicle; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState<"fuel" | "service">("fuel");
  const [odo, setOdo] = useState("");
  const [litres, setLitres] = useState("");
  const [amount, setAmount] = useState("");
  const [full, setFull] = useState(true);
  const [on, setOn] = useState(localDay());
  const [saving, setSaving] = useState(false);
  const kmpl = mileage(v);
  const lastService = v.logs.find((l) => l.kind === "service");
  const odoNow = v.logs.length ? Math.max(...v.logs.map((l) => l.odometer_km)) : null;

  async function log(e: React.FormEvent) {
    e.preventDefault();
    const amountRs = amount ? parseFloat(resolveAmountInput(amount)) : null;
    setSaving(true);
    try {
      await lifeApi.addVehicleLog(v.id, {
        kind, on, odometerKm: Number(odo),
        litres: kind === "fuel" ? Number(litres) : null,
        amountCents: amountRs ? Math.round(amountRs * 100) : null,
        fullTank: full,
      });
      toast.success(kind === "fuel" ? "Fill-up logged" : "Service logged");
      setOdo(""); setLitres(""); setAmount("");
      await onChanged();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not log"));
    } finally {
      setSaving(false);
    }
  }

  async function removeLog(id: string) {
    try { await lifeApi.deleteVehicleLog(id); await onChanged(); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not remove")); }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-base font-semibold">{v.name}</h2>
        <span className="font-mono text-xs text-muted-foreground">
          {odoNow !== null ? `${odoNow.toLocaleString("en-IN")} km` : "no logs yet"}
          {kmpl ? ` · ${kmpl.toFixed(1)} km/L` : ""}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {lastService ? `Last service ${lastService.logged_on} at ${lastService.odometer_km.toLocaleString("en-IN")} km.` : "No service logged yet; log the last one so reminders can start."}
        {v.service_every_km || v.service_every_months ? ` Service every ${[v.service_every_km && `${v.service_every_km.toLocaleString("en-IN")} km`, v.service_every_months && `${v.service_every_months} months`].filter(Boolean).join(" or ")}.` : ""}
      </p>

      <form onSubmit={log} className="flex flex-wrap items-end gap-2">
        <div className="inline-flex rounded-lg border bg-background p-0.5" role="group" aria-label="Log type">
          {(["fuel", "service"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
              {k === "fuel" ? "Fill-up" : "Service"}
            </button>
          ))}
        </div>
        <Input aria-label="Odometer (km)" inputMode="numeric" required value={odo} onChange={(e) => setOdo(e.target.value)} placeholder="Odometer km" className="h-9 w-32" />
        {kind === "fuel" && <Input aria-label="Litres" inputMode="decimal" required value={litres} onChange={(e) => setLitres(e.target.value)} placeholder="Litres" className="h-9 w-24" />}
        <Input aria-label="Amount (₹)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹ amount" className="h-9 w-28" />
        <Input aria-label="Date" type="date" value={on} onChange={(e) => setOn(e.target.value)} className="h-9 w-36" />
        {kind === "fuel" && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} className="size-4 accent-[var(--primary)]" /> Full tank
          </label>
        )}
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Log"}</Button>
      </form>

      {v.logs.length > 0 && (
        <ul className="divide-y text-sm">
          {v.logs.slice(0, 6).map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{l.logged_on}</span>
              <span className="min-w-0 flex-1">
                {l.kind === "fuel" ? `${l.litres} L${l.full_tank ? "" : " (partial)"}` : "Service"} · {l.odometer_km.toLocaleString("en-IN")} km
              </span>
              <span className="font-mono text-xs tabular-nums">{l.amount_cents ? formatCents(l.amount_cents, "INR") : ""}</span>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void removeLog(l.id)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
