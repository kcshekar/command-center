"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { remindersApi, REMINDER_CATEGORIES, type Reminder } from "@/lib/reminders-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { BellRing, Check, Plus, Send, Trash2 } from "lucide-react";

function isOverdue(dueOn: string): boolean {
  return new Date(dueOn) < new Date(new Date().toDateString());
}

export default function RemindersPage() {
  const { user } = useAuth();
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("bill");
  const [dueOn, setDueOn] = useState(new Date().toISOString().slice(0, 10));
  const [recurrence, setRecurrence] = useState("");
  const [saving, setSaving] = useState(false);

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

  async function handleCreate() {
    if (!title.trim() || !category || !dueOn) return;
    setSaving(true);
    try {
      await remindersApi.create({ title: title.trim(), category, dueOn, recurrence: recurrence || undefined });
      setTitle("");
      setRecurrence("");
      setOpen(false);
      toast.success("Reminder created");
      await refresh();
    } catch {
      toast.error("Failed to create reminder");
    } finally {
      setSaving(false);
    }
  }

  async function handleAcknowledge(id: string) {
    try {
      const result = await remindersApi.acknowledge(id);
      toast.success(result.nextDueOn ? `Next due ${result.nextDueOn}` : "Acknowledged");
      await refresh();
    } catch {
      toast.error("Failed to acknowledge");
    }
  }

  async function handleDelete(id: string) {
    try {
      await remindersApi.remove(id);
      toast.success("Reminder deleted");
      await refresh();
    } catch {
      toast.error("Failed to delete reminder");
    }
  }

  async function handleSweep() {
    setSweeping(true);
    try {
      const result = await remindersApi.notifyDue();
      toast.success(`${result.notified} reminder(s) sent to Slack`);
    } catch {
      toast.error("Sweep failed — is Slack configured?");
    } finally {
      setSweeping(false);
    }
  }

  const sorted = [...reminders].sort((a, b) => new Date(a.due_on).getTime() - new Date(b.due_on).getTime());

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reminders</h1>
          <p className="text-sm text-muted-foreground">Bills, insurance, loans, vehicle maintenance — due in the next 60 days.</p>
        </div>
        <div className="flex items-center gap-2">
          {isOwnerOrAdmin && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleSweep} disabled={sweeping}>
              <Send className="size-4" /> {sweeping ? "Sending…" : "Sweep now"}
            </Button>
          )}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
              <Plus className="size-4" /> New reminder
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New reminder</DialogTitle>
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
                <Button onClick={handleCreate} disabled={saving || !title.trim()}>
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Recurrence</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => {
              const overdue = isOverdue(r.due_on);
              return (
                <TableRow key={r.id}>
                  <TableCell className="flex items-center gap-1.5">
                    {overdue && <BellRing className="size-3.5 text-destructive" />}
                    {r.title}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.category}</Badge>
                  </TableCell>
                  <TableCell className={overdue ? "text-destructive" : ""}>{r.due_on.slice(0, 10)}</TableCell>
                  <TableCell className="text-muted-foreground">{r.recurrence ?? "one-off"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" onClick={() => handleAcknowledge(r.id)} aria-label="Acknowledge">
                        <Check className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(r.id)} aria-label="Delete">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
