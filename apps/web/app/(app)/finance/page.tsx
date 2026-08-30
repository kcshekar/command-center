"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { financeApi, formatCents, formatDate, type RecurringBill, type Expense, type ExpenseSummaryRow, type FinanceProject, type Employee, type PayrollRun, type CaPayment, type TaxRecord, type RecommendationsResponse } from "@/lib/finance-api";
import { remindersApi } from "@/lib/reminders-api";
import { initials, avatarColorClass } from "@/lib/avatar";
import { AnimatedNumber } from "@/components/animated-number";
import { resolveAmountInput } from "@/lib/calc";
import { ExpenseChart } from "@/components/finance/expense-chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, ArrowUpRight, Bell, Pause, Play, Plus, TrendingDown, TrendingUp, AlertTriangle, Pencil, Trash2 } from "lucide-react";
import { apiErrorMessage } from "@/lib/api";

// Manual link from a finance record to Reminders (payroll runs, CA
// payments) — opens pre-filled, resourceType/resourceId tie it back to
// the record it came from. Nothing is created until the user confirms.
function RemindMeButton({
  title,
  resourceType,
  resourceId,
  defaultDueOn,
  defaultRecurrence = "",
  onCreated,
}: {
  title: string;
  resourceType: string;
  resourceId: string;
  defaultDueOn: string;
  defaultRecurrence?: string;
  onCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reminderTitle, setReminderTitle] = useState(title);
  const [dueOn, setDueOn] = useState(defaultDueOn);
  const [recurrence, setRecurrence] = useState(defaultRecurrence);
  const [saving, setSaving] = useState(false);

  function openDialog() {
    setReminderTitle(title);
    setDueOn(defaultDueOn);
    setRecurrence(defaultRecurrence);
    setOpen(true);
  }

  async function handleCreate() {
    if (!reminderTitle.trim() || !dueOn) return;
    setSaving(true);
    try {
      await remindersApi.create({ title: reminderTitle.trim(), category: "other", dueOn, recurrence: recurrence || undefined, resourceType, resourceId });
      toast.success("Reminder created");
      setOpen(false);
      onCreated?.();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to create reminder"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon" className="size-7" onClick={openDialog} aria-label="Remind me" />}>
        <Bell className="size-3.5" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create reminder</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="remind-title">Title</Label>
            <Input id="remind-title" value={reminderTitle} onChange={(e) => setReminderTitle(e.target.value)} />
          </div>
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="remind-due">Due on</Label>
              <Input id="remind-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="remind-recurrence">Recurrence</Label>
              <select
                id="remind-recurrence"
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
              >
                <option value="">One-off</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleCreate} disabled={saving || !reminderTitle.trim() || !dueOn}>
            {saving ? "Creating…" : "Create reminder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SEVERITY_VARIANT: Record<string, "default" | "outline" | "destructive"> = {
  info: "outline",
  warning: "default",
  critical: "destructive",
};

export default function FinancePage() {
  const { user } = useAuth();
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  if (!isOwnerOrAdmin) return <MyPayrollView />;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Finance</h1>
        <p className="text-sm text-muted-foreground">Bills, expenses, project ledgers, payroll, and tax.</p>
      </div>
      <Tabs defaultValue="overview">
        <TabsList className="w-full">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="expenses">Bills &amp; Expenses</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="payroll">Payroll</TabsTrigger>
          <TabsTrigger value="tax">Tax &amp; CA</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-2 border-t pt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="expenses" className="mt-2 border-t pt-4">
          <BillsAndExpensesTab />
        </TabsContent>
        <TabsContent value="projects" className="mt-2 border-t pt-4">
          <ProjectsTab />
        </TabsContent>
        <TabsContent value="payroll" className="mt-2 border-t pt-4">
          <PayrollTab />
        </TabsContent>
        <TabsContent value="tax" className="mt-2 border-t pt-4">
          <TaxTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OverviewTab() {
  const [summary, setSummary] = useState<ExpenseSummaryRow[]>([]);
  const [recs, setRecs] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([financeApi.expenseSummary(6), financeApi.recommendations(3)])
      .then(([s, r]) => {
        setSummary(s);
        setRecs(r);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-6">
      {recs && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard label="Income (3mo)" value={recs.incomeCents} />
          <KpiCard label="Expenses (3mo)" value={recs.totalExpensesCents} />
          <KpiCard
            label="Savings rate"
            valueLabel={recs.savingsRate !== null ? `${(recs.savingsRate * 100).toFixed(1)}%` : "—"}
            trend={recs.savingsRate === null ? undefined : recs.savingsRate >= 0 ? "up" : "down"}
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Expenses, last 6 months</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpenseChart rows={summary} />
        </CardContent>
      </Card>

      {recs && recs.recommendations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recommendations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {recs.recommendations.map((r, i) => (
              <div
                key={i}
                className="flex animate-in items-start gap-2 fade-in slide-in-from-bottom-1 text-sm duration-300"
                style={{ animationDelay: `${i * 60}ms`, animationFillMode: "backwards" }}
              >
                <Badge variant={SEVERITY_VARIANT[r.severity]} className="mt-0.5 shrink-0">
                  {r.severity === "critical" && <AlertTriangle className="size-3" />}
                  {r.severity}
                </Badge>
                <p>{r.message}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  valueLabel,
  trend,
}: {
  label: string;
  value?: number;
  valueLabel?: string;
  trend?: "up" | "down";
}) {
  return (
    <div className="rounded-2xl border bg-card p-4 transition-shadow hover:shadow-md">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-xl font-semibold tabular-nums">
        {value != null ? <AnimatedNumber value={value} format={formatCents} /> : valueLabel}
      </p>
      {trend && (
        <p className={`mt-1 flex items-center gap-1 text-xs ${trend === "up" ? "text-success" : "text-destructive"}`}>
          {trend === "up" ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
          {trend === "up" ? "Trending up" : "Trending down"}
        </p>
      )}
    </div>
  );
}

// Bills (recurring obligations) and Expenses (one-off, dated spend) are two
// different tables server-side, but present near-identically — amount,
// currency, category — so they're shown in one merged list here, split only
// by a Recurring toggle in the Add/Edit dialog. Keeping the tables separate
// avoids a risky data migration; this is a UI-level merge only.
function nextBillDueDate(bill: RecurringBill): string {
  const today = new Date();
  if (bill.cadence === "yearly") {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (bill.cadence === "weekly") {
    const d = new Date(today);
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  // monthly (default): due_day this month, or next month if already passed
  const day = bill.due_day ?? today.getDate();
  let d = new Date(today.getFullYear(), today.getMonth(), day);
  if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, day);
  return d.toISOString().slice(0, 10);
}

function BillsAndExpensesTab() {
  const [bills, setBills] = useState<RecurringBill[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ type: "bill" | "expense"; id: string } | null>(null);
  const [isRecurring, setIsRecurring] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [cadence, setCadence] = useState("monthly");
  const [dueDay, setDueDay] = useState("");
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ type: "bill" | "expense"; id: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [b, e] = await Promise.all([financeApi.listBills(), financeApi.listExpenses()]);
      setBills(b);
      setExpenses(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function openCreate() {
    setEditing(null);
    setIsRecurring(false);
    setName("");
    setAmount("");
    setCategory("");
    setCadence("monthly");
    setDueDay("");
    setOccurredOn(new Date().toISOString().slice(0, 10));
    setNote("");
    setOpen(true);
  }

  function openEditBill(b: RecurringBill) {
    setEditing({ type: "bill", id: b.id });
    setIsRecurring(true);
    setName(b.name);
    setAmount(String(b.amount_cents / 100));
    setCategory(b.category);
    setCadence(b.cadence);
    setDueDay(b.due_day ? String(b.due_day) : "");
    setOpen(true);
  }

  function openEditExpense(e: Expense) {
    setEditing({ type: "expense", id: e.id });
    setIsRecurring(false);
    setAmount(String(e.amount_cents / 100));
    setCategory(e.category);
    setOccurredOn(formatDate(e.occurred_on));
    setNote(e.note ?? "");
    setOpen(true);
  }

  async function handleSave() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || !category.trim()) return;
    setSaving(true);
    try {
      if (isRecurring) {
        if (!name.trim()) return;
        const params = { name: name.trim(), amountCents: cents, cadence, category: category.trim(), dueDay: dueDay ? Number(dueDay) : undefined };
        if (editing?.type === "bill") {
          await financeApi.updateBill(editing.id, params);
          toast.success("Bill updated");
        } else {
          await financeApi.createBill(params);
          toast.success("Bill added");
        }
      } else {
        if (!occurredOn) return;
        const params = { amountCents: cents, category: category.trim(), occurredOn, note: note.trim() || undefined };
        if (editing?.type === "expense") {
          await financeApi.updateExpense(editing.id, params);
          toast.success("Expense updated");
        } else {
          await financeApi.createExpense(params);
          toast.success("Expense recorded");
        }
      }
      setOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editing ? "Failed to update" : "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(bill: RecurringBill) {
    try {
      await financeApi.setBillActive(bill.id, !bill.active);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to update bill"));
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      if (confirmDelete.type === "bill") {
        await financeApi.deleteBill(confirmDelete.id);
        toast.success("Bill deleted");
      } else {
        await financeApi.deleteExpense(confirmDelete.id);
        toast.success("Expense deleted");
      }
      setConfirmDelete(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete"));
    } finally {
      setDeleting(false);
    }
  }

  // Recurring bills first (no fixed past date), sorted by name; then
  // expenses newest first.
  const rows = [
    ...[...bills].sort((a, b) => a.name.localeCompare(b.name)).map((b) => ({ type: "bill" as const, data: b })),
    ...[...expenses].sort((a, b) => new Date(b.occurred_on).getTime() - new Date(a.occurred_on).getTime()).map((e) => ({ type: "expense" as const, data: e })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
            <Plus className="size-4" /> Add
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? `Edit ${editing.type}` : "Add bill or expense"}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              {!editing && (
                <div className="flex items-center gap-2">
                  <input id="is-recurring" type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
                  <Label htmlFor="is-recurring">Recurring bill (not a one-off expense)</Label>
                </div>
              )}
              {isRecurring && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="be-name">Name</Label>
                  <Input id="be-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Netflix" />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="be-amount">Amount (₹)</Label>
                <Input
                  id="be-amount"
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onBlur={(e) => setAmount(resolveAmountInput(e.target.value))}
                  placeholder="500 or 500+120-30"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="be-category">Category</Label>
                <Input id="be-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={isRecurring ? "subscription" : "groceries"} />
              </div>
              {isRecurring ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="be-cadence">Cadence</Label>
                    <select id="be-cadence" value={cadence} onChange={(e) => setCadence(e.target.value)} className="h-9 rounded-md border bg-transparent px-3 text-sm">
                      <option value="monthly">Monthly</option>
                      <option value="yearly">Yearly</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="be-due">Due day (optional)</Label>
                    <Input id="be-due" type="number" value={dueDay} onChange={(e) => setDueDay(e.target.value)} placeholder="5" />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="be-date">Date</Label>
                    <Input id="be-date" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="be-note">Note</Label>
                    <Input id="be-note" value={note} onChange={(e) => setNote(e.target.value)} />
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bills or expenses yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Description</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Reminder</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const isBill = row.type === "bill";
              const bill = isBill ? (row.data as RecurringBill) : null;
              const expense = !isBill ? (row.data as Expense) : null;
              const isDeleting = confirmDelete?.type === row.type && confirmDelete.id === row.data.id;
              return (
                <TableRow key={`${row.type}-${row.data.id}`}>
                  <TableCell>{bill ? bill.name : expense!.note || expense!.category}</TableCell>
                  <TableCell>{row.data.category}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {bill ? (
                      <span className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px] font-normal capitalize">
                          {bill.cadence}
                        </Badge>
                        {bill.due_day ? `due ${bill.due_day}` : ""}
                        {!bill.active && (
                          <Badge variant="secondary" className="text-[10px] font-normal">
                            Paused
                          </Badge>
                        )}
                      </span>
                    ) : (
                      formatDate(expense!.occurred_on)
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatCents(row.data.amount_cents, row.data.currency)}</TableCell>
                  <TableCell>
                    {row.data.reminder_count > 0 ? (
                      <Badge variant="outline" className="gap-1 text-[10px] font-normal">
                        <Bell className="size-3" /> {row.data.reminder_due_on ? formatDate(row.data.reminder_due_on) : "Set"}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not set</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {isDeleting ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="text-xs text-muted-foreground">Delete?</span>
                        <Button variant="destructive" size="sm" disabled={deleting} onClick={handleDelete}>
                          {deleting ? "…" : "Confirm"}
                        </Button>
                        <Button variant="outline" size="sm" disabled={deleting} onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        {row.data.reminder_count === 0 && (
                          <RemindMeButton
                            title={bill ? bill.name : expense!.note || expense!.category}
                            resourceType={row.type}
                            resourceId={row.data.id}
                            defaultDueOn={bill ? nextBillDueDate(bill) : expense!.occurred_on.slice(0, 10)}
                            defaultRecurrence={bill ? bill.cadence : ""}
                            onCreated={refresh}
                          />
                        )}
                        {bill && (
                          <Button variant="ghost" size="icon" className="size-7" onClick={() => toggleActive(bill)} aria-label={bill.active ? "Pause" : "Resume"}>
                            {bill.active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => (bill ? openEditBill(bill) : openEditExpense(expense!))}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDelete({ type: row.type, id: row.data.id })}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    )}
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

function ProjectsTab() {
  const [projects, setProjects] = useState<FinanceProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setProjects(await financeApi.listProjects());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await financeApi.createProject({ name: name.trim() });
      setName("");
      setOpen(false);
      toast.success("Project created");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to create project"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> New project
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New finance project</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="fp-name">Name</Label>
              <Input id="fp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="NURAKNECT" autoFocus />
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={saving || !name.trim()}>
                {saving ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No finance projects yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => {
            const netCents = p.inward_cents - p.outward_cents;
            return (
              <Link
                key={p.id}
                href={`/finance/${p.id}`}
                className="group animate-in fade-in slide-in-from-bottom-2 duration-300"
                style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
              >
                <div className="relative overflow-hidden rounded-2xl border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md">
                  <span
                    className={`absolute inset-y-0 left-0 w-1 ${netCents > 0 ? "bg-success" : netCents < 0 ? "bg-destructive" : "bg-muted-foreground/30"}`}
                  />
                  <div className="flex items-center gap-3">
                    <div className={`flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColorClass(p.name)}`}>
                      {initials(p.name)}
                    </div>
                    <h3 className="min-w-0 flex-1 truncate text-base font-medium">{p.name}</h3>
                    <ArrowUpRight className="size-4 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Inward</p>
                      <p className="font-mono text-sm font-semibold tabular-nums text-success">
                        <AnimatedNumber value={p.inward_cents} format={formatCents} />
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Outward</p>
                      <p className="font-mono text-sm font-semibold tabular-nums text-destructive">
                        <AnimatedNumber value={p.outward_cents} format={formatCents} />
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Net</p>
                      <p className="font-mono text-sm font-semibold tabular-nums">
                        <AnimatedNumber value={netCents} format={formatCents} />
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {p.entry_count} {p.entry_count === 1 ? "entry" : "entries"}
                    {p.last_entry_on && ` · last ${formatDate(p.last_entry_on)}`}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function payrollSummary(employeeId: string, runs: PayrollRun[]) {
  const empRuns = [...runs]
    .filter((r) => r.employee_id === employeeId)
    .sort((a, b) => new Date(b.period_end).getTime() - new Date(a.period_end).getTime());
  const lastRun = empRuns[0] ?? null;
  const totalPaidCents = empRuns.reduce((s, r) => s + Number(r.net_cents), 0);
  let nextDueEstimate: string | null = null;
  if (lastRun) {
    const d = new Date(lastRun.period_end);
    d.setMonth(d.getMonth() + 1);
    nextDueEstimate = d.toISOString().slice(0, 10);
  }
  return { lastRun, totalRuns: empRuns.length, totalPaidCents, nextDueEstimate };
}

function PayrollTab() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);

  const [empOpen, setEmpOpen] = useState(false);
  const [editingEmpId, setEditingEmpId] = useState<string | null>(null);
  const [empName, setEmpName] = useState("");
  const [rate, setRate] = useState("");
  const [savingEmp, setSavingEmp] = useState(false);
  const [confirmDeleteEmpId, setConfirmDeleteEmpId] = useState<string | null>(null);
  const [deletingEmp, setDeletingEmp] = useState(false);

  const [runOpen, setRunOpen] = useState(false);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [gross, setGross] = useState("");
  const [taxWithheld, setTaxWithheld] = useState("");
  const [savingRun, setSavingRun] = useState(false);
  const [confirmDeleteRunId, setConfirmDeleteRunId] = useState<string | null>(null);
  const [deletingRun, setDeletingRun] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [e, r] = await Promise.all([financeApi.listEmployees(), financeApi.listPayrollRuns()]);
      setEmployees(e);
      setRuns(r);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function openCreateEmployee() {
    setEditingEmpId(null);
    setEmpName("");
    setRate("");
    setEmpOpen(true);
  }

  function openEditEmployee(e: Employee) {
    setEditingEmpId(e.id);
    setEmpName(e.name);
    setRate(e.hourly_rate_cents ? String(e.hourly_rate_cents / 100) : "");
    setEmpOpen(true);
  }

  async function handleSaveEmployee() {
    if (!empName.trim()) return;
    setSavingEmp(true);
    try {
      const params = { name: empName.trim(), hourlyRateCents: rate ? Math.round(parseFloat(rate) * 100) : undefined };
      if (editingEmpId) {
        await financeApi.updateEmployee(editingEmpId, params);
        toast.success("Employee updated");
      } else {
        await financeApi.createEmployee(params);
        toast.success("Employee added");
      }
      setEmpOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingEmpId ? "Failed to update employee" : "Failed to add employee"));
    } finally {
      setSavingEmp(false);
    }
  }

  async function handleDeleteEmployee(id: string) {
    setDeletingEmp(true);
    try {
      await financeApi.deleteEmployee(id);
      toast.success("Employee deleted");
      setConfirmDeleteEmpId(null);
      if (selectedEmployeeId === id) setSelectedEmployeeId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete employee — check they have no payroll history"));
    } finally {
      setDeletingEmp(false);
    }
  }

  function openCreateRun(forEmployeeId?: string) {
    setEditingRunId(null);
    setEmployeeId(forEmployeeId ?? "");
    setPeriodStart("");
    setPeriodEnd("");
    setGross("");
    setTaxWithheld("");
    setRunOpen(true);
  }

  function openEditRun(r: PayrollRun) {
    setEditingRunId(r.id);
    setEmployeeId(r.employee_id);
    setPeriodStart(formatDate(r.period_start));
    setPeriodEnd(formatDate(r.period_end));
    setGross(String(r.gross_cents / 100));
    setTaxWithheld(r.tax_withheld_cents ? String(r.tax_withheld_cents / 100) : "");
    setRunOpen(true);
  }

  async function handleSaveRun() {
    const grossCents = Math.round(parseFloat(gross) * 100);
    const taxCents = taxWithheld ? Math.round(parseFloat(taxWithheld) * 100) : 0;
    if (!employeeId || !periodStart || !periodEnd || !grossCents) return;
    setSavingRun(true);
    try {
      if (editingRunId) {
        await financeApi.updatePayrollRun(editingRunId, { periodStart, periodEnd, grossCents, taxWithheldCents: taxCents });
        toast.success("Payroll run updated");
      } else {
        await financeApi.createPayrollRun({ employeeId, periodStart, periodEnd, grossCents, taxWithheldCents: taxCents });
        toast.success("Payroll run recorded");
      }
      setRunOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingRunId ? "Failed to update payroll run" : "Failed to record payroll run"));
    } finally {
      setSavingRun(false);
    }
  }

  async function handleDeleteRun(id: string) {
    setDeletingRun(true);
    try {
      await financeApi.deletePayrollRun(id);
      toast.success("Payroll run deleted");
      setConfirmDeleteRunId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete payroll run"));
    } finally {
      setDeletingRun(false);
    }
  }

  const runDialog = (
    <Dialog open={runOpen} onOpenChange={setRunOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingRunId ? "Edit payroll run" : "Record payroll run"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="run-employee">Employee</Label>
            <select
              id="run-employee"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              disabled={!!editingRunId || !!selectedEmployeeId}
              className="h-9 rounded-md border bg-transparent px-3 text-sm disabled:opacity-60"
            >
              <option value="">Select…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="run-start">Period start</Label>
              <Input id="run-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="run-end">Period end</Label>
              <Input id="run-end" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="run-gross">Gross (₹)</Label>
            <Input
              id="run-gross"
              type="text"
              inputMode="decimal"
              value={gross}
              onChange={(e) => setGross(e.target.value)}
              onBlur={(e) => setGross(resolveAmountInput(e.target.value))}
              placeholder="40000"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="run-tax">Tax withheld (₹, optional)</Label>
            <Input
              id="run-tax"
              type="text"
              inputMode="decimal"
              value={taxWithheld}
              onChange={(e) => setTaxWithheld(e.target.value)}
              onBlur={(e) => setTaxWithheld(resolveAmountInput(e.target.value))}
              placeholder="4000"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSaveRun} disabled={savingRun || !employeeId}>
            {savingRun ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const selectedEmployee = employees.find((e) => e.id === selectedEmployeeId) ?? null;

  if (selectedEmployee) {
    const empRuns = [...runs]
      .filter((r) => r.employee_id === selectedEmployee.id)
      .sort((a, b) => new Date(b.period_end).getTime() - new Date(a.period_end).getTime());
    const summary = payrollSummary(selectedEmployee.id, runs);

    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setSelectedEmployeeId(null)} aria-label="Back to employees">
            <ArrowLeft className="size-4" />
          </Button>
          <div className="flex-1">
            <h3 className="text-base font-medium">{selectedEmployee.name}</h3>
            <p className="text-xs text-muted-foreground">
              {selectedEmployee.employment_type}
              {!selectedEmployee.active && " · inactive"}
            </p>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => openCreateRun(selectedEmployee.id)}>
            <Plus className="size-4" /> Record payroll
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-2xl border bg-card p-4 transition-shadow hover:shadow-md">
            <p className="text-xs text-muted-foreground">Total paid</p>
            <p className="mt-2 font-mono text-xl font-semibold tabular-nums">
              <AnimatedNumber value={summary.totalPaidCents} format={formatCents} />
            </p>
          </div>
          <div className="rounded-2xl border bg-card p-4 transition-shadow hover:shadow-md">
            <p className="text-xs text-muted-foreground">Last paid</p>
            <p className="mt-2 font-mono text-xl font-semibold tabular-nums">{summary.lastRun ? formatDate(summary.lastRun.period_end) : "—"}</p>
          </div>
          <div className="rounded-2xl border bg-card p-4 transition-shadow hover:shadow-md">
            <p className="text-xs text-muted-foreground">Runs</p>
            <p className="mt-2 font-mono text-xl font-semibold tabular-nums">
              <AnimatedNumber value={summary.totalRuns} format={(n) => Math.round(n).toString()} />
            </p>
          </div>
        </div>

        {empRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payroll runs for this employee yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {empRuns.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {formatDate(r.period_start)} → {formatDate(r.period_end)}
                  </TableCell>
                  <TableCell className="text-right">{formatCents(r.gross_cents)}</TableCell>
                  <TableCell className="text-right">{formatCents(r.tax_withheld_cents)}</TableCell>
                  <TableCell className="text-right font-medium">{formatCents(r.net_cents)}</TableCell>
                  <TableCell className="text-right">
                    {confirmDeleteRunId === r.id ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="text-xs text-muted-foreground">Delete?</span>
                        <Button variant="destructive" size="sm" disabled={deletingRun} onClick={() => handleDeleteRun(r.id)}>
                          {deletingRun ? "…" : "Confirm"}
                        </Button>
                        <Button variant="outline" size="sm" disabled={deletingRun} onClick={() => setConfirmDeleteRunId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <RemindMeButton
                          title={`Pay ${selectedEmployee.name}`}
                          resourceType="payroll_run"
                          resourceId={r.id}
                          defaultDueOn={payrollSummary(selectedEmployee.id, runs).nextDueEstimate ?? formatDate(r.period_end)}
                        />
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => openEditRun(r)}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDeleteRunId(r.id)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {runDialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Employees</h3>
        <Dialog open={empOpen} onOpenChange={setEmpOpen}>
          <DialogTrigger render={<Button size="sm" variant="outline" className="gap-1.5" onClick={openCreateEmployee} />}>
            <Plus className="size-4" /> Add employee
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingEmpId ? "Edit employee" : "Add employee"}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="emp-name">Name</Label>
                <Input id="emp-name" value={empName} onChange={(e) => setEmpName(e.target.value)} placeholder="Priya" autoFocus />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="emp-rate">Hourly rate (₹, optional)</Label>
                <Input
                  id="emp-rate"
                  type="text"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  onBlur={(e) => setRate(resolveAmountInput(e.target.value))}
                  placeholder="500"
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleSaveEmployee} disabled={savingEmp || !empName.trim()}>
                {savingEmp ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {employees.length === 0 ? (
        <p className="text-sm text-muted-foreground">No employees yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {employees.map((e, i) => {
            const summary = payrollSummary(e.id, runs);
            return (
              <div
                key={e.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedEmployeeId(e.id)}
                onKeyDown={(ev) => ev.key === "Enter" && setSelectedEmployeeId(e.id)}
                className="group animate-in cursor-pointer rounded-2xl border bg-card p-3 text-left fade-in slide-in-from-bottom-2 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
                style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div
                      className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white transition-transform duration-300 group-hover:scale-110 ${avatarColorClass(e.name)}`}
                    >
                      {initials(e.name)}
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">{e.name}</h3>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">{e.employment_type}</span>
                        <Badge variant={e.active ? "outline" : "secondary"} className="text-[10px] font-normal">
                          {e.active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  {confirmDeleteEmpId === e.id ? (
                    <div className="flex shrink-0 items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
                      <Button variant="destructive" size="sm" disabled={deletingEmp} onClick={() => handleDeleteEmployee(e.id)}>
                        {deletingEmp ? "…" : "Confirm"}
                      </Button>
                      <Button variant="outline" size="sm" disabled={deletingEmp} onClick={() => setConfirmDeleteEmpId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div
                      className="flex shrink-0 translate-x-1 items-center gap-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => openEditEmployee(e)} aria-label="Edit">
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDeleteEmpId(e.id)} aria-label="Delete">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </div>

                {/* Always-visible compact line */}
                <div className="mt-2.5 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    Last paid {summary.lastRun ? formatDate(summary.lastRun.period_end) : "—"}
                  </span>
                  <span className="font-mono font-semibold tabular-nums">
                    {summary.lastRun ? <AnimatedNumber value={summary.lastRun.net_cents} format={formatCents} /> : "—"}
                  </span>
                </div>

                {/* Expands open on hover — grid-rows trick keeps the collapsed
                    card's footprint small without an overflow/height jump. */}
                <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 group-hover:grid-rows-[1fr]">
                  <div className="overflow-hidden">
                    <div className="mt-2.5 grid grid-cols-2 gap-3 border-t pt-2.5 text-xs">
                      <div>
                        <p className="text-muted-foreground">Next due (est.)</p>
                        <p className="mt-0.5 font-mono font-medium tabular-nums">{summary.nextDueEstimate ? formatDate(summary.nextDueEstimate) : "—"}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Total paid</p>
                        <p className="mt-0.5 font-mono font-medium tabular-nums">
                          <AnimatedNumber value={summary.totalPaidCents} format={formatCents} />
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {runDialog}
    </div>
  );
}

function TaxTab() {
  const [caPayments, setCaPayments] = useState<CaPayment[]>([]);
  const [taxRecords, setTaxRecords] = useState<TaxRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [caOpen, setCaOpen] = useState(false);
  const [editingCaId, setEditingCaId] = useState<string | null>(null);
  const [caAmount, setCaAmount] = useState("");
  const [caPurpose, setCaPurpose] = useState("");
  const [caPaidOn, setCaPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [savingCa, setSavingCa] = useState(false);
  const [confirmDeleteCaId, setConfirmDeleteCaId] = useState<string | null>(null);
  const [deletingCa, setDeletingCa] = useState(false);

  const [taxOpen, setTaxOpen] = useState(false);
  const [editingTaxId, setEditingTaxId] = useState<string | null>(null);
  const [taxYear, setTaxYear] = useState(new Date().getFullYear().toString());
  const [taxCategory, setTaxCategory] = useState("");
  const [taxAmount, setTaxAmount] = useState("");
  const [savingTax, setSavingTax] = useState(false);
  const [confirmDeleteTaxId, setConfirmDeleteTaxId] = useState<string | null>(null);
  const [deletingTax, setDeletingTax] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [ca, tax] = await Promise.all([financeApi.listCaPayments(), financeApi.listTaxRecords()]);
      setCaPayments(ca);
      setTaxRecords(tax);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function openCreateCa() {
    setEditingCaId(null);
    setCaAmount("");
    setCaPurpose("");
    setCaPaidOn(new Date().toISOString().slice(0, 10));
    setCaOpen(true);
  }

  function openEditCa(c: CaPayment) {
    setEditingCaId(c.id);
    setCaAmount(String(c.amount_cents / 100));
    setCaPurpose(c.purpose ?? "");
    setCaPaidOn(formatDate(c.paid_on));
    setCaOpen(true);
  }

  async function handleSaveCa() {
    const cents = Math.round(parseFloat(caAmount) * 100);
    if (!cents || !caPaidOn) return;
    setSavingCa(true);
    try {
      const params = { amountCents: cents, purpose: caPurpose.trim() || undefined, paidOn: caPaidOn };
      if (editingCaId) {
        await financeApi.updateCaPayment(editingCaId, params);
        toast.success("CA payment updated");
      } else {
        await financeApi.createCaPayment(params);
        toast.success("CA payment recorded");
      }
      setCaOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingCaId ? "Failed to update CA payment" : "Failed to record CA payment"));
    } finally {
      setSavingCa(false);
    }
  }

  async function handleDeleteCa(id: string) {
    setDeletingCa(true);
    try {
      await financeApi.deleteCaPayment(id);
      toast.success("CA payment deleted");
      setConfirmDeleteCaId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete CA payment"));
    } finally {
      setDeletingCa(false);
    }
  }

  function openCreateTax() {
    setEditingTaxId(null);
    setTaxYear(new Date().getFullYear().toString());
    setTaxCategory("");
    setTaxAmount("");
    setTaxOpen(true);
  }

  function openEditTax(t: TaxRecord) {
    setEditingTaxId(t.id);
    setTaxYear(String(t.tax_year));
    setTaxCategory(t.category);
    setTaxAmount(String(t.amount_cents / 100));
    setTaxOpen(true);
  }

  async function handleSaveTax() {
    const cents = Math.round(parseFloat(taxAmount) * 100);
    if (!cents || !taxCategory.trim() || !taxYear) return;
    setSavingTax(true);
    try {
      const params = { taxYear: Number(taxYear), category: taxCategory.trim(), amountCents: cents };
      if (editingTaxId) {
        await financeApi.updateTaxRecord(editingTaxId, params);
        toast.success("Tax record updated");
      } else {
        await financeApi.createTaxRecord(params);
        toast.success("Tax record added");
      }
      setTaxOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingTaxId ? "Failed to update tax record" : "Failed to add tax record"));
    } finally {
      setSavingTax(false);
    }
  }

  async function handleDeleteTax(id: string) {
    setDeletingTax(true);
    try {
      await financeApi.deleteTaxRecord(id);
      toast.success("Tax record deleted");
      setConfirmDeleteTaxId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete tax record"));
    } finally {
      setDeletingTax(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">CA payments</h3>
        <Dialog open={caOpen} onOpenChange={setCaOpen}>
          <DialogTrigger render={<Button size="sm" variant="outline" className="gap-1.5" onClick={openCreateCa} />}>
            <Plus className="size-4" /> Add payment
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingCaId ? "Edit CA payment" : "Add CA payment"}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ca-amount">Amount (₹)</Label>
                <Input
                  id="ca-amount"
                  type="text"
                  inputMode="decimal"
                  value={caAmount}
                  onChange={(e) => setCaAmount(e.target.value)}
                  onBlur={(e) => setCaAmount(resolveAmountInput(e.target.value))}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ca-purpose">Purpose</Label>
                <Input id="ca-purpose" value={caPurpose} onChange={(e) => setCaPurpose(e.target.value)} placeholder="Annual filing" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ca-date">Paid on</Label>
                <Input id="ca-date" type="date" value={caPaidOn} onChange={(e) => setCaPaidOn(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleSaveCa} disabled={savingCa}>
                {savingCa ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {caPayments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No CA payments yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Purpose</TableHead>
              <TableHead>Paid on</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {caPayments.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.purpose ?? "—"}</TableCell>
                <TableCell>{formatDate(c.paid_on)}</TableCell>
                <TableCell className="text-right">{formatCents(c.amount_cents)}</TableCell>
                <TableCell className="text-right">
                  {confirmDeleteCaId === c.id ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-xs text-muted-foreground">Delete?</span>
                      <Button variant="destructive" size="sm" disabled={deletingCa} onClick={() => handleDeleteCa(c.id)}>
                        {deletingCa ? "…" : "Confirm"}
                      </Button>
                      <Button variant="outline" size="sm" disabled={deletingCa} onClick={() => setConfirmDeleteCaId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-1">
                      <RemindMeButton
                        title={`CA payment${c.purpose ? `: ${c.purpose}` : ""}`}
                        resourceType="ca_payment"
                        resourceId={c.id}
                        defaultDueOn={(() => {
                          const d = new Date(c.paid_on);
                          d.setMonth(d.getMonth() + 1);
                          return d.toISOString().slice(0, 10);
                        })()}
                      />
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => openEditCa(c)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDeleteCaId(c.id)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Tax records</h3>
        <Dialog open={taxOpen} onOpenChange={setTaxOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreateTax} />}>
            <Plus className="size-4" /> Add record
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingTaxId ? "Edit tax record" : "Add tax record"}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="tax-year">Tax year</Label>
                <Input id="tax-year" type="number" value={taxYear} onChange={(e) => setTaxYear(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="tax-category">Category</Label>
                <Input id="tax-category" value={taxCategory} onChange={(e) => setTaxCategory(e.target.value)} placeholder="gst" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="tax-amount">Amount (₹)</Label>
                <Input
                  id="tax-amount"
                  type="text"
                  inputMode="decimal"
                  value={taxAmount}
                  onChange={(e) => setTaxAmount(e.target.value)}
                  onBlur={(e) => setTaxAmount(resolveAmountInput(e.target.value))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleSaveTax} disabled={savingTax}>
                {savingTax ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {taxRecords.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tax records yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Year</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {taxRecords.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.tax_year}</TableCell>
                <TableCell>{t.category}</TableCell>
                <TableCell className="text-right">{formatCents(t.amount_cents)}</TableCell>
                <TableCell className="text-right">
                  {confirmDeleteTaxId === t.id ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-xs text-muted-foreground">Delete?</span>
                      <Button variant="destructive" size="sm" disabled={deletingTax} onClick={() => handleDeleteTax(t.id)}>
                        {deletingTax ? "…" : "Confirm"}
                      </Button>
                      <Button variant="outline" size="sm" disabled={deletingTax} onClick={() => setConfirmDeleteTaxId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => openEditTax(t)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDeleteTaxId(t.id)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function MyPayrollView() {
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    financeApi
      .myPayrollRuns()
      .then(setRuns)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">My Payroll</h1>
        <p className="text-sm text-muted-foreground">Your own payment history.</p>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payroll records yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  {formatDate(r.period_start)} → {formatDate(r.period_end)}
                </TableCell>
                <TableCell className="text-right">{formatCents(r.gross_cents)}</TableCell>
                <TableCell className="text-right">{formatCents(r.tax_withheld_cents)}</TableCell>
                <TableCell className="text-right font-medium">{formatCents(r.net_cents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
