"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { financeApi, formatCents, formatDate, type FinanceProjectDetail, type LedgerEntry, type CaInvoiceBatch } from "@/lib/finance-api";
import { resolveAmountInput } from "@/lib/calc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { FileDown, Mail, Pencil, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { apiErrorMessage } from "@/lib/api";
import { AnimatedNumber } from "@/components/animated-number";
import { Breadcrumb } from "@/components/breadcrumb";

function KpiTile({ label, value, tone }: { label: string; value: number; tone?: "success" | "destructive" }) {
  return (
    <div className="rounded-2xl border bg-card p-4 transition-shadow hover:shadow-md">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-2 font-mono text-xl font-semibold tabular-nums ${tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : ""}`}>
        <AnimatedNumber value={value} format={formatCents} />
      </p>
    </div>
  );
}

type InvoiceStatus = "none" | "draft" | "sent";
function invoiceStatusOf(l: LedgerEntry): InvoiceStatus {
  if (!l.invoice_number) return "none";
  return l.invoice_sent_at ? "sent" : "draft";
}

export default function FinanceProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<FinanceProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [direction, setDirection] = useState<"inward" | "outward">("inward");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [amountInr, setAmountInr] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const [sendOpen, setSendOpen] = useState(false);
  const [sendingEntry, setSendingEntry] = useState<LedgerEntry | null>(null);
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendSubject, setSendSubject] = useState("");
  const [sendBody, setSendBody] = useState("");
  const [sending, setSending] = useState(false);

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

  function openCreate() {
    setEditingId(null);
    setDirection("inward");
    setAmount("");
    setCurrency("INR");
    setAmountInr("");
    setCounterparty("");
    setOccurredOn(new Date().toISOString().slice(0, 10));
    setOpen(true);
  }

  function openEdit(l: LedgerEntry) {
    setEditingId(l.id);
    setDirection(l.direction);
    setAmount(String(l.amount_cents / 100));
    setCurrency(l.currency);
    setAmountInr(l.amount_inr_cents ? String(l.amount_inr_cents / 100) : "");
    setCounterparty(l.counterparty);
    setOccurredOn(formatDate(l.occurred_on));
    setOpen(true);
  }

  async function handleSave() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || !counterparty.trim() || !occurredOn) return;
    setSaving(true);
    try {
      const params = {
        direction,
        amountCents: cents,
        currency,
        amountInrCents: amountInr ? Math.round(parseFloat(amountInr) * 100) : undefined,
        counterparty: counterparty.trim(),
        occurredOn,
      };
      if (editingId) {
        await financeApi.updateProjectLedgerEntry(projectId, editingId, params);
        toast.success("Ledger entry updated");
      } else {
        await financeApi.addLedgerEntry(projectId, params);
        toast.success("Ledger entry added");
      }
      setOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingId ? "Failed to update ledger entry" : "Failed to add ledger entry"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(entryId: string) {
    setDeleting(true);
    try {
      await financeApi.deleteProjectLedgerEntry(projectId, entryId);
      toast.success("Ledger entry deleted");
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete ledger entry"));
    } finally {
      setDeleting(false);
    }
  }

  async function handleExportPdf(entryId: string) {
    setExportingId(entryId);
    try {
      await financeApi.downloadInvoicePdf(projectId, entryId);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to generate invoice PDF"));
    } finally {
      setExportingId(null);
    }
  }

  function openSendInvoice(l: LedgerEntry) {
    setSendingEntry(l);
    setSendRecipient("");
    setSendSubject(`Invoice — ${l.counterparty}`);
    setSendBody(
      `Hi,\n\nPlease find attached the invoice for ${formatCents(l.amount_cents, l.currency)} dated ${formatDate(l.occurred_on)}.\n\nThanks.`
    );
    setSendOpen(true);
  }

  async function handleSendInvoice() {
    if (!sendingEntry || !sendRecipient.trim() || !sendSubject.trim() || !sendBody.trim()) return;
    setSending(true);
    try {
      await financeApi.sendInvoice(projectId, sendingEntry.id, {
        recipientEmail: sendRecipient.trim(),
        subject: sendSubject.trim(),
        body: sendBody.trim(),
      });
      toast.success("Invoice sent");
      setSendOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to send invoice"));
    } finally {
      setSending(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!project) return <p className="text-sm text-destructive">Project not found.</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <Breadcrumb items={[{ label: "Finance", href: "/finance" }, { label: project.name }]} />
          <h1 className="mt-1 text-xl font-heading font-semibold tracking-tight">{project.name}</h1>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
            <Plus className="size-4" /> Add entry
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit ledger entry" : "Add ledger entry"}</DialogTitle>
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
              <div className="flex gap-3">
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="ledger-amount">Amount</Label>
                  <Input
                    id="ledger-amount"
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    onBlur={(e) => setAmount(resolveAmountInput(e.target.value))}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ledger-currency">Currency</Label>
                  <select
                    id="ledger-currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  >
                    <option value="INR">INR</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </div>
              </div>
              {direction === "inward" && currency !== "INR" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ledger-amount-inr">INR received (optional)</Label>
                  <Input
                    id="ledger-amount-inr"
                    type="text"
                    inputMode="decimal"
                    value={amountInr}
                    onChange={(e) => setAmountInr(e.target.value)}
                    onBlur={(e) => setAmountInr(resolveAmountInput(e.target.value))}
                    placeholder="Actual amount credited to your bank, in INR"
                  />
                </div>
              )}
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
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <KpiTile label="Inward" value={project.inwardCents} tone="success" />
        <KpiTile label="Outward" value={project.outwardCents} tone="destructive" />
        <KpiTile label="Net" value={project.netCents} />
      </div>

      <Tabs defaultValue="ledger">
        <TabsList className="w-full">
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="ca-invoices">CA Invoices</TabsTrigger>
        </TabsList>
        <TabsContent value="ledger" className="mt-2 border-t pt-4">
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
                  <TableHead>Invoice</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {project.ledger.map((l) => {
                  const invoiceable = l.direction === "inward" && l.currency !== "INR";
                  const status = invoiceStatusOf(l);
                  return (
                    <TableRow key={l.id}>
                      <TableCell>{formatDate(l.occurred_on)}</TableCell>
                      <TableCell>{l.counterparty}</TableCell>
                      <TableCell className={l.direction === "inward" ? "text-success" : "text-destructive"}>{l.direction}</TableCell>
                      <TableCell className="text-right">
                        {formatCents(l.amount_cents, l.currency)}
                        {l.amount_inr_cents != null && (
                          <div className="text-xs font-normal text-muted-foreground">{formatCents(l.amount_inr_cents)} received</div>
                        )}
                      </TableCell>
                      <TableCell>
                        {!invoiceable ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : status === "none" ? (
                          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                            Not invoiced
                          </Badge>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <Badge variant={status === "sent" ? "default" : "outline"} className="w-fit text-[10px] font-normal">
                              {status === "sent" ? "Sent" : "Draft"}
                            </Badge>
                            <span className="font-mono text-[10px] text-muted-foreground">{l.invoice_number}</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {confirmDeleteId === l.id ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="text-xs text-muted-foreground">Delete?</span>
                            <Button variant="destructive" size="sm" disabled={deleting} onClick={() => handleDelete(l.id)}>
                              {deleting ? "…" : "Confirm"}
                            </Button>
                            <Button variant="outline" size="sm" disabled={deleting} onClick={() => setConfirmDeleteId(null)}>
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            {invoiceable && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7"
                                  disabled={exportingId === l.id}
                                  onClick={() => handleExportPdf(l.id)}
                                  aria-label="Export invoice PDF"
                                >
                                  <FileDown className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7"
                                  onClick={() => openSendInvoice(l)}
                                  aria-label="Send invoice"
                                >
                                  <Mail className="size-3.5" />
                                </Button>
                              </>
                            )}
                            <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(l)}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDeleteId(l.id)}>
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
        </TabsContent>
        <TabsContent value="ca-invoices" className="mt-2 border-t pt-4">
          <CaInvoicesSection projectId={projectId} />
        </TabsContent>
      </Tabs>

      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send invoice</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="inv-recipient">Recipient email</Label>
              <Input id="inv-recipient" type="email" value={sendRecipient} onChange={(e) => setSendRecipient(e.target.value)} placeholder="client@example.com" autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="inv-subject">Subject</Label>
              <Input id="inv-subject" value={sendSubject} onChange={(e) => setSendSubject(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="inv-body">Message</Label>
              <textarea
                id="inv-body"
                value={sendBody}
                onChange={(e) => setSendBody(e.target.value)}
                rows={5}
                className="rounded-md border bg-transparent px-3 py-2 text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleSendInvoice} disabled={sending || !sendRecipient.trim() || !sendSubject.trim() || !sendBody.trim()} className="gap-1.5">
              <Send className="size-4" /> {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// One email per month bundling that month's foreign-currency inward
// invoices from THIS project's ledger — for one-off sends see the Send
// icon on individual Ledger rows instead. Generating a draft never sends
// anything — Ollama writes the cover email, but a human reviews/edits and
// explicitly hits Send.
function CaInvoicesSection({ projectId }: { projectId: string }) {
  const [batches, setBatches] = useState<CaInvoiceBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodMonth, setPeriodMonth] = useState(new Date().toISOString().slice(0, 7));
  const [generating, setGenerating] = useState(false);

  const [sendOpen, setSendOpen] = useState(false);
  const [sendingBatch, setSendingBatch] = useState<CaInvoiceBatch | null>(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setBatches(await financeApi.listCaInvoiceBatches(projectId));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleGenerate() {
    setGenerating(true);
    try {
      await financeApi.generateCaInvoiceBatch(projectId, periodMonth);
      toast.success("Draft email prepared");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to generate batch — check there are inward foreign-currency entries for that month"));
    } finally {
      setGenerating(false);
    }
  }

  function openSend(b: CaInvoiceBatch) {
    setSendingBatch(b);
    setRecipientEmail(b.recipient_email);
    setSubject(b.draft_subject);
    setBody(b.draft_body);
    setSendOpen(true);
  }

  async function handleSend() {
    if (!sendingBatch || !recipientEmail.trim() || !subject.trim() || !body.trim()) return;
    setSending(true);
    try {
      await financeApi.sendCaInvoiceBatch(sendingBatch.id, { recipientEmail: recipientEmail.trim(), subject: subject.trim(), body: body.trim() });
      toast.success("Email sent to CA");
      setSendOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to send email"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="ca-batch-month">Generate monthly batch</Label>
        <div className="flex gap-2">
          <Input id="ca-batch-month" type="month" value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)} className="w-40" />
          <Button size="sm" className="gap-1.5" disabled={generating} onClick={handleGenerate}>
            <Sparkles className="size-4" /> {generating ? "Drafting…" : "Generate draft"}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Monthly batches</h3>
        {batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No batches yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{new Date(b.period_month).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</TableCell>
                  <TableCell className="text-muted-foreground">{b.recipient_email || "—"}</TableCell>
                  <TableCell className="text-right">{b.invoice_count}</TableCell>
                  <TableCell>
                    <Badge variant={b.status === "sent" ? "default" : "outline"}>{b.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {b.status === "draft" && (
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openSend(b)}>
                        <Send className="size-3.5" /> Review &amp; send
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review &amp; send to CA</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="send-recipient">Recipient email</Label>
              <Input id="send-recipient" type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} placeholder="ca@example.com" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="send-subject">Subject</Label>
              <Input id="send-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="send-body">Body (drafted by Ollama — edit as needed)</Label>
              <textarea
                id="send-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                className="rounded-md border bg-transparent px-3 py-2 text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleSend} disabled={sending || !recipientEmail.trim() || !subject.trim() || !body.trim()}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
