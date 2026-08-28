"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { financeApi, formatCents, formatDate, type Account, type RecurringBill, type Expense, type ExpenseSummaryRow, type FinanceProject, type Employee, type PayrollRun, type CaPayment, type TaxRecord, type RecommendationsResponse } from "@/lib/finance-api";
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
import { Plus, TrendingDown, TrendingUp, AlertTriangle } from "lucide-react";

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
        <h1 className="text-xl font-semibold tracking-tight">Finance</h1>
        <p className="text-sm text-muted-foreground">Bills, expenses, project ledgers, payroll, and tax.</p>
      </div>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
          <TabsTrigger value="bills">Bills</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="payroll">Payroll</TabsTrigger>
          <TabsTrigger value="tax">Tax &amp; CA</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="expenses" className="pt-4">
          <ExpensesTab />
        </TabsContent>
        <TabsContent value="bills" className="pt-4">
          <BillsTab />
        </TabsContent>
        <TabsContent value="projects" className="pt-4">
          <ProjectsTab />
        </TabsContent>
        <TabsContent value="payroll" className="pt-4">
          <PayrollTab />
        </TabsContent>
        <TabsContent value="tax" className="pt-4">
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
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Expenses, last 6 months</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpenseChart rows={summary} />
        </CardContent>
      </Card>

      {recs && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recommendations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Income (3mo)</p>
                <p className="text-lg font-medium">{formatCents(recs.incomeCents)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Expenses (3mo)</p>
                <p className="text-lg font-medium">{formatCents(recs.totalExpensesCents)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Savings rate</p>
                <p className="flex items-center gap-1 text-lg font-medium">
                  {recs.savingsRate !== null ? `${(recs.savingsRate * 100).toFixed(1)}%` : "—"}
                  {recs.savingsRate !== null && (recs.savingsRate >= 0 ? <TrendingUp className="size-4 text-green-500" /> : <TrendingDown className="size-4 text-destructive" />)}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {recs.recommendations.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <Badge variant={SEVERITY_VARIANT[r.severity]} className="mt-0.5 shrink-0">
                    {r.severity === "critical" && <AlertTriangle className="size-3" />}
                    {r.severity}
                  </Badge>
                  <p>{r.message}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ExpensesTab() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [e, a] = await Promise.all([financeApi.listExpenses(), financeApi.listAccounts()]);
      setExpenses(e);
      setAccounts(a);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || !category.trim() || !occurredOn) return;
    setSaving(true);
    try {
      await financeApi.createExpense({ amountCents: cents, category: category.trim(), occurredOn, note: note.trim() || undefined });
      setAmount("");
      setCategory("");
      setNote("");
      setOpen(false);
      toast.success("Expense recorded");
      await refresh();
    } catch {
      toast.error("Failed to record expense");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> Add expense
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add expense</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="exp-amount">Amount (₹)</Label>
                <Input id="exp-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="exp-category">Category</Label>
                <Input id="exp-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="groceries" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="exp-date">Date</Label>
                <Input id="exp-date" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="exp-note">Note</Label>
                <Input id="exp-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : expenses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No expenses yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {expenses.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{formatDate(e.occurred_on)}</TableCell>
                <TableCell>{e.category}</TableCell>
                <TableCell className="text-muted-foreground">{e.note}</TableCell>
                <TableCell className="text-right">{formatCents(e.amount_cents, e.currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function BillsTab() {
  const [bills, setBills] = useState<RecurringBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState("monthly");
  const [category, setCategory] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setBills(await financeApi.listBills());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!name.trim() || !cents || !category.trim()) return;
    setSaving(true);
    try {
      await financeApi.createBill({ name: name.trim(), amountCents: cents, cadence, category: category.trim(), dueDay: dueDay ? Number(dueDay) : undefined });
      setName("");
      setAmount("");
      setCategory("");
      setDueDay("");
      setOpen(false);
      toast.success("Bill added");
      await refresh();
    } catch {
      toast.error("Failed to add bill");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(bill: RecurringBill) {
    try {
      await financeApi.setBillActive(bill.id, !bill.active);
      await refresh();
    } catch {
      toast.error("Failed to update bill");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> New bill
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New recurring bill</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="bill-name">Name</Label>
                <Input id="bill-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Netflix" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="bill-amount">Amount (₹)</Label>
                <Input id="bill-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="649" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="bill-cadence">Cadence</Label>
                <select id="bill-cadence" value={cadence} onChange={(e) => setCadence(e.target.value)} className="h-9 rounded-md border bg-transparent px-3 text-sm">
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="bill-category">Category</Label>
                <Input id="bill-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="subscription" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="bill-due">Due day (optional)</Label>
                <Input id="bill-due" type="number" value={dueDay} onChange={(e) => setDueDay(e.target.value)} placeholder="5" />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : bills.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recurring bills yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Cadence</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bills.map((b) => (
              <TableRow key={b.id}>
                <TableCell>{b.name}</TableCell>
                <TableCell>{b.category}</TableCell>
                <TableCell>{b.cadence}</TableCell>
                <TableCell className="text-right">{formatCents(b.amount_cents, b.currency)}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => toggleActive(b)}>
                    {b.active ? "Active" : "Paused"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
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
    } catch {
      toast.error("Failed to create project");
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
          {projects.map((p) => (
            <Link key={p.id} href={`/finance/${p.id}`}>
              <Card className="cursor-pointer transition-colors hover:border-primary/50">
                <CardHeader>
                  <CardTitle className="text-base font-medium">{p.name}</CardTitle>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function PayrollTab() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [loading, setLoading] = useState(true);

  const [empOpen, setEmpOpen] = useState(false);
  const [empName, setEmpName] = useState("");
  const [rate, setRate] = useState("");
  const [savingEmp, setSavingEmp] = useState(false);

  const [runOpen, setRunOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [gross, setGross] = useState("");
  const [taxWithheld, setTaxWithheld] = useState("");
  const [savingRun, setSavingRun] = useState(false);

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

  async function handleCreateEmployee() {
    if (!empName.trim()) return;
    setSavingEmp(true);
    try {
      await financeApi.createEmployee({ name: empName.trim(), hourlyRateCents: rate ? Math.round(parseFloat(rate) * 100) : undefined });
      setEmpName("");
      setRate("");
      setEmpOpen(false);
      toast.success("Employee added");
      await refresh();
    } catch {
      toast.error("Failed to add employee");
    } finally {
      setSavingEmp(false);
    }
  }

  async function handleCreateRun() {
    const grossCents = Math.round(parseFloat(gross) * 100);
    const taxCents = taxWithheld ? Math.round(parseFloat(taxWithheld) * 100) : 0;
    if (!employeeId || !periodStart || !periodEnd || !grossCents) return;
    setSavingRun(true);
    try {
      await financeApi.createPayrollRun({ employeeId, periodStart, periodEnd, grossCents, taxWithheldCents: taxCents });
      setPeriodStart("");
      setPeriodEnd("");
      setGross("");
      setTaxWithheld("");
      setRunOpen(false);
      toast.success("Payroll run recorded");
      await refresh();
    } catch {
      toast.error("Failed to record payroll run");
    } finally {
      setSavingRun(false);
    }
  }

  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name ?? id;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Employees</h3>
        <Dialog open={empOpen} onOpenChange={setEmpOpen}>
          <DialogTrigger render={<Button size="sm" variant="outline" className="gap-1.5" />}>
            <Plus className="size-4" /> Add employee
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add employee</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="emp-name">Name</Label>
                <Input id="emp-name" value={empName} onChange={(e) => setEmpName(e.target.value)} placeholder="Priya" autoFocus />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="emp-rate">Hourly rate (₹, optional)</Label>
                <Input id="emp-rate" type="number" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="500" />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreateEmployee} disabled={savingEmp || !empName.trim()}>
                {savingEmp ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : employees.length === 0 ? (
        <p className="text-sm text-muted-foreground">No employees yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Hourly rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {employees.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{e.name}</TableCell>
                <TableCell>{e.employment_type}</TableCell>
                <TableCell className="text-right">{e.hourly_rate_cents ? formatCents(e.hourly_rate_cents) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Payroll runs</h3>
        <Dialog open={runOpen} onOpenChange={setRunOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" disabled={employees.length === 0} />}>
            <Plus className="size-4" /> Record payroll
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Record payroll run</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="run-employee">Employee</Label>
                <select id="run-employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="h-9 rounded-md border bg-transparent px-3 text-sm">
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
                <Input id="run-gross" type="number" value={gross} onChange={(e) => setGross(e.target.value)} placeholder="40000" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="run-tax">Tax withheld (₹, optional)</Label>
                <Input id="run-tax" type="number" value={taxWithheld} onChange={(e) => setTaxWithheld(e.target.value)} placeholder="4000" />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreateRun} disabled={savingRun || !employeeId}>
                {savingRun ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payroll runs yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{employeeName(r.employee_id)}</TableCell>
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

function TaxTab() {
  const [caPayments, setCaPayments] = useState<CaPayment[]>([]);
  const [taxRecords, setTaxRecords] = useState<TaxRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [caOpen, setCaOpen] = useState(false);
  const [caAmount, setCaAmount] = useState("");
  const [caPurpose, setCaPurpose] = useState("");
  const [caPaidOn, setCaPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [savingCa, setSavingCa] = useState(false);

  const [taxOpen, setTaxOpen] = useState(false);
  const [taxYear, setTaxYear] = useState(new Date().getFullYear().toString());
  const [taxCategory, setTaxCategory] = useState("");
  const [taxAmount, setTaxAmount] = useState("");
  const [savingTax, setSavingTax] = useState(false);

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

  async function handleCreateCa() {
    const cents = Math.round(parseFloat(caAmount) * 100);
    if (!cents || !caPaidOn) return;
    setSavingCa(true);
    try {
      await financeApi.createCaPayment({ amountCents: cents, purpose: caPurpose.trim() || undefined, paidOn: caPaidOn });
      setCaAmount("");
      setCaPurpose("");
      setCaOpen(false);
      toast.success("CA payment recorded");
      await refresh();
    } catch {
      toast.error("Failed to record CA payment");
    } finally {
      setSavingCa(false);
    }
  }

  async function handleCreateTax() {
    const cents = Math.round(parseFloat(taxAmount) * 100);
    if (!cents || !taxCategory.trim() || !taxYear) return;
    setSavingTax(true);
    try {
      await financeApi.createTaxRecord({ taxYear: Number(taxYear), category: taxCategory.trim(), amountCents: cents });
      setTaxCategory("");
      setTaxAmount("");
      setTaxOpen(false);
      toast.success("Tax record added");
      await refresh();
    } catch {
      toast.error("Failed to add tax record");
    } finally {
      setSavingTax(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">CA payments</h3>
        <Dialog open={caOpen} onOpenChange={setCaOpen}>
          <DialogTrigger render={<Button size="sm" variant="outline" className="gap-1.5" />}>
            <Plus className="size-4" /> Add payment
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add CA payment</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ca-amount">Amount (₹)</Label>
                <Input id="ca-amount" type="number" value={caAmount} onChange={(e) => setCaAmount(e.target.value)} />
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
              <Button onClick={handleCreateCa} disabled={savingCa}>
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {caPayments.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.purpose ?? "—"}</TableCell>
                <TableCell>{formatDate(c.paid_on)}</TableCell>
                <TableCell className="text-right">{formatCents(c.amount_cents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Tax records</h3>
        <Dialog open={taxOpen} onOpenChange={setTaxOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> Add record
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add tax record</DialogTitle>
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
                <Input id="tax-amount" type="number" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreateTax} disabled={savingTax}>
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {taxRecords.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.tax_year}</TableCell>
                <TableCell>{t.category}</TableCell>
                <TableCell className="text-right">{formatCents(t.amount_cents)}</TableCell>
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
        <h1 className="text-xl font-semibold tracking-tight">My Payroll</h1>
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
