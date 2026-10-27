"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/api";
import { lifeApi, localDay, type Habit } from "@/lib/life-api";
import { cn } from "@/lib/utils";

// R11 — habits, logged here (works well on a phone). Tap a habit to mark
// today done; tap again to undo. The Habit check-in automation nudges at
// 21:00 for anything not logged and sends the week on Sundays.

const WEEKS = 8;

function shift(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

/** Consecutive days done, ending today — or yesterday, so tonight isn't a break yet. */
function streak(done: Set<string>, today: string): number {
  let day = done.has(today) ? today : shift(today, -1);
  let n = 0;
  while (done.has(day)) { n++; day = shift(day, -1); }
  return n;
}

export default function HabitsPage() {
  const [habits, setHabits] = useState<Habit[] | null>(null);
  const [name, setName] = useState("");
  const today = localDay();

  async function refresh() {
    try { setHabits(await lifeApi.habits(WEEKS * 7)); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not load habits")); setHabits([]); }
  }
  useEffect(() => { void refresh(); }, []);

  async function toggle(h: Habit) {
    const done = !h.done.includes(today);
    // Optimistic: flip locally, roll back if the save fails.
    setHabits((prev) => prev?.map((x) => x.id === h.id ? { ...x, done: done ? [...x.done, today] : x.done.filter((d) => d !== today) } : x) ?? prev);
    try { await lifeApi.logHabit(h.id, today, done); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not save")); void refresh(); }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try { await lifeApi.addHabit(name.trim()); setName(""); await refresh(); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not add habit")); }
  }

  async function archive(h: Habit) {
    try { await lifeApi.updateHabit(h.id, { active: !h.active }); await refresh(); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not update habit")); }
  }

  const active = (habits ?? []).filter((h) => h.active);
  const archived = (habits ?? []).filter((h) => !h.active);
  const doneToday = active.filter((h) => h.done.includes(today)).length;
  // Heatmap columns are weeks (oldest → newest), rows Mon … Sun: start on the
  // Monday WEEKS-1 weeks before this one; days after today render empty.
  const weekday = (new Date(`${today}T12:00:00`).getDay() + 6) % 7; // Mon = 0
  const start = shift(today, -(weekday + (WEEKS - 1) * 7));

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Habits</h1>
        <p className="text-sm text-muted-foreground">
          {habits === null ? "Loading…" : active.length === 0 ? "Add the habits you want to keep." : `${doneToday} of ${active.length} done today. Tap to log.`}{" "}
          <Link href="/automations/r11.habits" className="font-medium text-primary">Evening nudge</Link>
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {active.map((h) => {
          const set = new Set(h.done);
          const isDone = set.has(today);
          const s = streak(set, today);
          return (
            <li key={h.id} className="rounded-xl border bg-card">
              <button
                onClick={() => void toggle(h)}
                aria-pressed={isDone}
                className="flex w-full items-center gap-3 px-4 py-3 text-left"
              >
                <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors", isDone ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                  {isDone && <Check className="size-4" />}
                </span>
                <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{h.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{s >= 2 ? `${s}-day streak` : s === 1 ? "1 day" : ""}</span>
              </button>
              <div className="flex flex-wrap items-end justify-between gap-3 border-t px-4 py-2.5">
                <div
                  className="grid grid-flow-col grid-rows-7 gap-[3px]"
                  role="img"
                  aria-label={`${h.name}: done ${h.done.length} of the last ${WEEKS * 7} days`}
                >
                  {Array.from({ length: WEEKS * 7 }, (_, i) => {
                    const day = shift(start, i);
                    return (
                      <i
                        key={day}
                        title={day}
                        className={cn("size-2.5 rounded-[2px]", set.has(day) ? "bg-primary" : day > today ? "bg-transparent" : "bg-muted")}
                      />
                    );
                  })}
                </div>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void archive(h)}>Archive</Button>
              </div>
            </li>
          );
        })}
      </ul>

      <form onSubmit={add} className="flex gap-2">
        <Input aria-label="New habit" value={name} onChange={(e) => setName(e.target.value)} placeholder="Read 20 pages" className="h-10" />
        <Button type="submit" className="h-10">Add</Button>
      </form>

      {archived.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Archived ({archived.length})</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {archived.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{h.name}</span>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void archive(h)}>Restore</Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
