"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import { occasionsApi, type Occasion, type OccasionInput } from "@/lib/occasions-api";

// R3 — birthdays & anniversaries. Private to you. The Birthdays &
// anniversaries automation sends a heads-up with gift ideas a week ahead and
// a message draft on the day.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EMPTY: OccasionInput = { person: "", relationship: "", kind: "birthday", month: 1, day: 1, year: null, notes: "" };

/** Days until the next occurrence (0 = today); Feb 29 counts as Feb 28 off leap years. */
function daysUntil(o: Occasion, now = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const on = (y: number) => {
    const last = new Date(y, o.month, 0).getDate();
    return new Date(y, o.month - 1, Math.min(o.day, last));
  };
  let d = on(today.getFullYear());
  if (d < today) d = on(today.getFullYear() + 1);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export default function OccasionsPage() {
  const [rows, setRows] = useState<Occasion[] | null>(null);
  const [form, setForm] = useState<OccasionInput>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try { setRows(await occasionsApi.list()); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not load occasions")); setRows([]); }
  }
  useEffect(() => { void refresh(); }, []);

  const sorted = useMemo(
    () => (rows ?? []).map((o) => ({ o, days: daysUntil(o) })).sort((a, b) => a.days - b.days),
    [rows],
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.person.trim()) { toast.error("Add a name"); return; }
    setSaving(true);
    try {
      const body = { ...form, relationship: form.relationship || null, notes: form.notes || null };
      if (editing) await occasionsApi.update(editing, body); else await occasionsApi.create(body);
      toast.success(editing ? "Saved" : `Added ${form.person}`);
      setForm(EMPTY); setEditing(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not save"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(o: Occasion) {
    try { await occasionsApi.remove(o.id); toast.success(`Removed ${o.person}`); await refresh(); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not remove")); }
  }

  const set = <K extends keyof OccasionInput>(k: K, v: OccasionInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Occasions</h1>
        <p className="text-sm text-muted-foreground">
          Birthdays and anniversaries, private to you. Turn on{" "}
          <Link href="/automations/r3.occasions" className="font-medium text-primary">Birthdays &amp; anniversaries</Link>{" "}
          for a heads-up with gift ideas a week ahead and a message draft on the day.
        </p>
      </div>

      <form onSubmit={save} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto_auto_auto]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="occ-person">Name</Label>
          <Input id="occ-person" value={form.person} onChange={(e) => set("person", e.target.value)} placeholder="Asha" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="occ-rel">Relationship</Label>
          <Input id="occ-rel" value={form.relationship ?? ""} onChange={(e) => set("relationship", e.target.value)} placeholder="sister" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="occ-kind">Occasion</Label>
          <select id="occ-kind" value={form.kind} onChange={(e) => set("kind", e.target.value as OccasionInput["kind"])} className="h-9 rounded-md border bg-transparent px-3 text-sm">
            <option value="birthday">Birthday</option>
            <option value="anniversary">Anniversary</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="occ-day">Day</Label>
          <Input id="occ-day" type="number" min={1} max={31} value={form.day} onChange={(e) => set("day", Number(e.target.value))} className="w-20" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="occ-month">Month</Label>
          <select id="occ-month" value={form.month} onChange={(e) => set("month", Number(e.target.value))} className="h-9 rounded-md border bg-transparent px-3 text-sm">
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="occ-year">Year (optional)</Label>
          <Input id="occ-year" type="number" min={1900} max={2100} value={form.year ?? ""} onChange={(e) => set("year", e.target.value ? Number(e.target.value) : null)} placeholder="1996" className="w-24" />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-5">
          <Label htmlFor="occ-notes">Notes for gift ideas</Label>
          <Input id="occ-notes" value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} placeholder="loves reading, into pottery lately" />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save" : "Add"}</Button>
          {editing && <Button type="button" variant="ghost" onClick={() => { setEditing(null); setForm(EMPTY); }}>Cancel</Button>}
        </div>
      </form>

      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet. Add the birthdays you never want to miss.</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {sorted.map(({ o, days }) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className={`w-20 shrink-0 font-mono text-xs ${days <= 7 ? "text-primary" : "text-muted-foreground"}`}>
                {days === 0 ? "today" : `in ${days}d`}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium [overflow-wrap:anywhere]">
                  {o.person}
                  <span className="ml-2 text-xs font-normal capitalize text-muted-foreground">{o.kind}{o.relationship ? ` · ${o.relationship}` : ""}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {o.day} {MONTHS[o.month - 1]}{o.year ? ` ${o.year}` : ""}{o.notes ? ` · ${o.notes}` : ""}
                </div>
              </div>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEditing(o.id); setForm({ ...o }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void remove(o)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
