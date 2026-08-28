"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { financeApi, formatCents, formatDate, type FinanceProjectDetail } from "@/lib/finance-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, Plus } from "lucide-react";

export default function FinanceProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<FinanceProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"inward" | "outward">("inward");
  const [amount, setAmount] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProject(await financeApi.getProject(projectId));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleAdd() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || !counterparty.trim() || !occurredOn) return;
    setSaving(true);
    try {
      await financeApi.addLedgerEntry(projectId, { direction, amountCents: cents, counterparty: counterparty.trim(), occurredOn });
      setAmount("");
      setCounterparty("");
      setOpen(false);
      toast.success("Ledger entry added");
      await refresh();
    } catch {
      toast.error("Failed to add ledger entry");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!project) return <p className="text-sm text-destructive">Project not found.</p>;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/finance" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Back to Finance
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> Add entry
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add ledger entry</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ledger-direction">Direction</Label>
                <select
                  id="ledger-direction"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as "inward" | "outward")}
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                >
                  <option value="inward">Inward (payment received)</option>
                  <option value="outward">Outward (payment made)</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ledger-amount">Amount (₹)</Label>
                <Input id="ledger-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ledger-counterparty">Counterparty</Label>
                <Input id="ledger-counterparty" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder="Client A" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ledger-date">Date</Label>
                <Input id="ledger-date" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleAdd} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Inward</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium">{formatCents(project.inwardCents)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Outward</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium">{formatCents(project.outwardCents)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Net</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium">{formatCents(project.netCents)}</CardContent>
        </Card>
      </div>

      {project.ledger.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ledger entries yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Counterparty</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {project.ledger.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{formatDate(l.occurred_on)}</TableCell>
                <TableCell>{l.counterparty}</TableCell>
                <TableCell className={l.direction === "inward" ? "text-green-500" : "text-destructive"}>{l.direction}</TableCell>
                <TableCell className="text-right">{formatCents(l.amount_cents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
