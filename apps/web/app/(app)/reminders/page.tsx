"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { remindersApi, REMINDER_CATEGORIES, type Reminder } from "@/lib/reminders-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { BellRing, Check, CheckCheck, ChevronLeft, ChevronRight, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/api";

function isOverdue(dueOn: string): boolean {
  return new Date(dueOn) < new Date(new Date().toDateString());
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

// No "danger" semantic per category — overdue-ness (styled separately) is
// what actually needs to read as urgent, not the category itself.
const CATEGORY_DOT: Record<string, string> = {
  bill: "bg-chart-3",
  insurance: "bg-chart-1",
  loan: "bg-chart-2",
  credit_card: "bg-chart-5",
  vehicle: "bg-chart-4",
  other: "bg-muted-foreground",
};

export default function RemindersPage() {
  const { user } = useAuth();
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("bill");
  const [dueOn, setDueOn] = useState(new Date().toISOString().slice(0, 10));
  const [recurrence, setRecurrence] = useState("");
  const [saving, setSaving] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setReminders(await remindersApi.list(60));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function openCreate() {
    setEditingId(null);
    setTitle("");
    setCategory("bill");
    setDueOn(new Date().toISOString().slice(0, 10));
    setRecurrence("");
    setOpen(true);
  }

  function openEdit(r: Reminder) {
    setEditingId(r.id);
    setTitle(r.title);
    setCategory(r.category);
    setDueOn(r.due_on.slice(0, 10));
    setRecurrence(r.recurrence ?? "");
    setOpen(true);
  }

  async function handleSave() {
    if (!title.trim() || !category || !dueOn) return;
    setSaving(true);
    try {
      const params = { title: title.trim(), category, dueOn, recurrence: recurrence || undefined };
      if (editingId) {
        await remindersApi.update(editingId, params);
        toast.success("Reminder updated");
      } else {
        await remindersApi.create(params);
        toast.success("Reminder created");
      }
      setOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingId ? "Failed to update reminder" : "Failed to create reminder"));
    } finally {
      setSaving(false);
    }
  }

  async function handleAcknowledge(id: string) {
    try {
      const result = await remindersApi.acknowledge(id);
      toast.success(result.nextDueOn ? `Next due ${result.nextDueOn}` : "Acknowledged");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to acknowledge"));
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      await remindersApi.remove(id);
      toast.success("Reminder deleted");
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete reminder"));
    } finally {
      setDeleting(false);
    }
  }

  async function handleSweep() {
    setSweeping(true);
    try {
      const result = await remindersApi.notifyDue();
      toast.success(`${result.notified} reminder(s) sent to Slack`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Sweep failed — is Slack configured?"));
    } finally {
      setSweeping(false);
    }
  }

  const sorted = [...reminders].sort((a, b) => new Date(a.due_on).getTime() - new Date(b.due_on).getTime());

  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const stripStart = new Date(today);
  stripStart.setDate(stripStart.getDate() + weekOffset * 7);
  const weekStrip = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(stripStart);
    day.setDate(day.getDate() + i);
    const items = sorted.filter((r) => sameDay(new Date(r.due_on), day));
    return { day, items };
  });

  const visible = selectedDay ? sorted.filter((r) => sameDay(new Date(r.due_on), selectedDay)) : sorted;

  const overdue = visible.filter((r) => isOverdue(r.due_on));
  const dueToday = visible.filter((r) => !isOverdue(r.due_on) && sameDay(new Date(r.due_on), today));
  const dueTomorrow = visible.filter((r) => sameDay(new Date(r.due_on), tomorrow));
  const dueThisWeek = visible.filter((r) => {
    const d = new Date(r.due_on);
    return d > tomorrow && d < weekEnd;
  });
  const dueLater = visible.filter((r) => new Date(r.due_on) >= weekEnd);

  const groups: { label: string; items: Reminder[] }[] = [
    { label: "Overdue", items: overdue },
    { label: "Today", items: dueToday },
    { label: "Tomorrow", items: dueTomorrow },
    { label: "This week", items: dueThisWeek },
    { label: "Later", items: dueLater },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight">Reminders</h1>
          <p className="text-sm text-muted-foreground">Bills, insurance, loans, vehicle maintenance — due in the next 60 days.</p>
        </div>
        <div className="flex items-center gap-2">
          {isOwnerOrAdmin && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleSweep} disabled={sweeping}>
              <Send className="size-4" /> {sweeping ? "Sending…" : "Sweep now"}
            </Button>
          )}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
              <Plus className="size-4" /> New reminder
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? "Edit reminder" : "New reminder"}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="rem-title">Title</Label>
                  <Input id="rem-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Car insurance renewal" autoFocus />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="rem-category">Category</Label>
                  <select id="rem-category" value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-md border bg-transparent px-3 text-sm">
                    {REMINDER_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="rem-due">Due on</Label>
                  <Input id="rem-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="rem-recurrence">Recurrence</Label>
                  <select id="rem-recurrence" value={recurrence} onChange={(e) => setRecurrence(e.target.value)} className="h-9 rounded-md border bg-transparent px-3 text-sm">
                    <option value="">One-off</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleSave} disabled={saving || !title.trim()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing due in the next 60 days.</p>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => setWeekOffset((w) => w - 1)} aria-label="Previous week">
              <ChevronLeft className="size-4" />
            </Button>
            <div key={weekOffset} className="grid flex-1 animate-in grid-cols-7 gap-2 fade-in slide-in-from-bottom-1 duration-200">
              {weekStrip.map(({ day, items }) => {
                const isToday = sameDay(day, today);
                const isSelected = selectedDay !== null && sameDay(day, selectedDay);
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    onClick={() => setSelectedDay((d) => (d && sameDay(d, day) ? null : day))}
                    className={cn(
                      "rounded-xl border bg-card p-2.5 text-center transition-all hover:-translate-y-0.5 hover:border-primary/50",
                      isToday && "border-primary bg-accent",
                      isSelected && "scale-105 border-primary bg-primary text-primary-foreground hover:border-primary"
                    )}
                  >
                    <div className={cn("text-[10px] uppercase tracking-wide text-muted-foreground", isSelected && "text-primary-foreground/70")}>
                      {day.toLocaleDateString(undefined, { weekday: "short" })}
                    </div>
                    <div className={cn("mt-0.5 font-mono text-sm", (isToday || isSelected) && "font-bold", isToday && !isSelected && "text-primary")}>
                      {day.getDate()}
                    </div>
                    <div className="mt-1 flex h-1.5 items-center justify-center gap-0.5">
                      {items.slice(0, 3).map((r) => (
                        <span key={r.id} className={cn("size-1.5 rounded-full", CATEGORY_DOT[r.category] ?? "bg-muted-foreground")} />
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => setWeekOffset((w) => w + 1)} aria-label="Next week">
              <ChevronRight className="size-4" />
            </Button>
          </div>

          {selectedDay && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              Showing {selectedDay.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
              <Button variant="ghost" size="icon" className="size-6" onClick={() => setSelectedDay(null)} aria-label="Clear date filter">
                <X className="size-3.5" />
              </Button>
            </div>
          )}

          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing due on this day.</p>
          )}

          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h4>
              {group.items.map((r, i) => {
                const overdue = isOverdue(r.due_on);
                const acknowledged = Boolean(r.notified_at);
                return (
                  <div
                    key={r.id}
                    className={cn(
                      "flex animate-in items-center gap-3 rounded-xl border bg-card px-3.5 py-3 fade-in slide-in-from-bottom-1 transition-shadow duration-300 hover:shadow-md",
                      acknowledged && "opacity-60"
                    )}
                    style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
                  >
                    <span className={cn("h-8 w-1 shrink-0 rounded-full", overdue ? "bg-destructive" : (CATEGORY_DOT[r.category] ?? "bg-muted-foreground"))} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        {overdue && !acknowledged && <BellRing className="size-3.5 shrink-0 text-destructive" />}
                        <span className="truncate">{r.title}</span>
                        {acknowledged && (
                          <Badge variant="outline" className="gap-1 text-[10px] font-normal">
                            <CheckCheck className="size-3" /> Acknowledged
                          </Badge>
                        )}
                      </div>
                      <div className={cn("text-xs text-muted-foreground", overdue && !acknowledged && "text-destructive")}>
                        {r.category} · {r.due_on.slice(0, 10)}
                        {r.recurrence ? ` · recurring ${r.recurrence}` : ""}
                      </div>
                    </div>
                    {confirmDeleteId === r.id ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">Delete?</span>
                        <Button variant="destructive" size="sm" disabled={deleting} onClick={() => handleDelete(r.id)}>
                          {deleting ? "…" : "Confirm"}
                        </Button>
                        <Button variant="outline" size="sm" disabled={deleting} onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 gap-1">
                        {!acknowledged && (
                          <Button variant="ghost" size="icon" onClick={() => handleAcknowledge(r.id)} aria-label="Acknowledge">
                            <Check className="size-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={() => openEdit(r)} aria-label="Edit">
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setConfirmDeleteId(r.id)} aria-label="Delete">
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
