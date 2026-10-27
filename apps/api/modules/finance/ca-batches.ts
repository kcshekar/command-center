import type { SQL } from "bun";
import { writeAudit } from "../../core/audit";
import { HttpError, type AuthCtx } from "../../core/auth";
import { draftText } from "../../core/ollama";
import { sendEmail } from "../../core/email";
import { renderInvoicePdf, invoiceNumberFor } from "./ca-invoice-pdf";

// Monthly CA invoice batches, shared by the Finance page routes and the N12
// automation (/api/integrations/ca-batches/*). Callers check permissions
// (owner/admin + project access); these functions just do the work.

// Get-or-create the CA invoice row for one ledger entry. The invoice number
// is assigned once, on first call, and persisted — reused by both the
// single-entry download route and the monthly batch generator so an entry
// invoiced individually and later swept into a batch keeps the same number.
export async function ensureInvoice(tx: SQL, ctx: AuthCtx, entry: { id: string; currency: string; amount_cents: number; occurred_on: string | Date }) {
  let [invoice] = await tx`
    SELECT id, invoice_number, invoice_date, amount_cents, currency FROM ca_invoices WHERE ledger_entry_id = ${entry.id}
  `;
  if (invoice) return invoice;

  // Bun's postgres driver round-trips a `date` column as a JS Date; handing
  // that Date straight back into a query serializes it with a
  // local-timezone abbreviation ("GMT+0530") Postgres can't parse, so it's
  // normalized to a plain YYYY-MM-DD string first.
  const occurredOnStr = new Date(entry.occurred_on).toISOString().slice(0, 10);
  const [{ count }] = await tx`SELECT count(*)::int FROM ca_invoices WHERE invoice_date = ${occurredOnStr}`;
  const invoiceNumber = invoiceNumberFor(new Date(entry.occurred_on), count + 1);
  [invoice] = await tx`
    INSERT INTO ca_invoices (org_id, ledger_entry_id, invoice_number, invoice_date, currency, amount_cents, created_by)
    VALUES (${ctx.orgId}, ${entry.id}, ${invoiceNumber}, ${occurredOnStr}, ${entry.currency}, ${entry.amount_cents}, ${ctx.userId})
    RETURNING id, invoice_number, invoice_date, amount_cents, currency
  `;
  await writeAudit(tx, ctx, { action: "ca_invoice:create", resourceType: "ca_invoice", resourceId: entry.id, metadata: { invoiceNumber } });
  return invoice;
}

// Bundle a project's foreign-currency inward entries for one month into a
// draft batch (invoices numbered once, cover email drafted by local Ollama).
// Re-running for the same month refreshes the existing draft.
export async function generateCaBatch(tx: SQL, ctx: AuthCtx, projectId: string, periodMonth: string) {
  if (!/^\d{4}-\d{2}$/.test(periodMonth ?? "")) throw new HttpError(400, "periodMonth must be YYYY-MM");
  const firstOfMonth = `${periodMonth}-01`;

  const entries = await tx`
    SELECT id, currency, amount_cents, occurred_on, counterparty
    FROM ledger_entries
    WHERE finance_project_id = ${projectId} AND direction = 'inward' AND currency <> 'INR'
      AND occurred_on >= ${firstOfMonth}::date AND occurred_on < (${firstOfMonth}::date + INTERVAL '1 month')
    ORDER BY occurred_on
  `;
  if (entries.length === 0) throw new HttpError(400, "no foreign-currency inward entries found for that month");

  const invoices = [];
  for (const entry of entries) {
    const invoice = await ensureInvoice(tx, ctx, entry);
    invoices.push({ ...invoice, counterparty: entry.counterparty });
  }

  const totalsByCurrency = new Map<string, number>();
  for (const inv of invoices) {
    totalsByCurrency.set(inv.currency, (totalsByCurrency.get(inv.currency) ?? 0) + Number(inv.amount_cents));
  }
  const monthLabel = new Date(`${firstOfMonth}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const invoiceLines = invoices.map((inv) => `${inv.invoice_number}: ${(Number(inv.amount_cents) / 100).toFixed(2)} ${inv.currency} from ${inv.counterparty}`).join("\n");
  const totalsLines = [...totalsByCurrency.entries()].map(([cur, cents]) => `${(cents / 100).toFixed(2)} ${cur}`).join(", ");
  const prompt = `Write a short, professional email (3-4 sentences, no subject line) to a chartered accountant, sending them export invoices for ${monthLabel} to file. Mention there are ${invoices.length} invoice(s) attached, totaling ${totalsLines}. Do not invent any other details.\n\nInvoices:\n${invoiceLines}`;
  const draftBody = await draftText(prompt);
  const draftSubject = `Export invoices for ${monthLabel} — PAMETNI TECH IT SOLUTIONS PRIVATE LIMITED`;
  const recipientEmail = "";

  const [existingDraft] = await tx`
    SELECT id FROM ca_invoice_batches WHERE period_month = ${firstOfMonth}::date AND status = 'draft' AND finance_project_id = ${projectId}
  `;
  let batch;
  if (existingDraft) {
    [batch] = await tx`
      UPDATE ca_invoice_batches SET recipient_email = ${recipientEmail}, draft_subject = ${draftSubject}, draft_body = ${draftBody}
      WHERE id = ${existingDraft.id}
      RETURNING id, period_month, recipient_email, draft_subject, draft_body, status
    `;
  } else {
    [batch] = await tx`
      INSERT INTO ca_invoice_batches (org_id, finance_project_id, period_month, recipient_email, draft_subject, draft_body, created_by)
      VALUES (${ctx.orgId}, ${projectId}, ${firstOfMonth}::date, ${recipientEmail}, ${draftSubject}, ${draftBody}, ${ctx.userId})
      RETURNING id, period_month, recipient_email, draft_subject, draft_body, status
    `;
  }
  for (const invoice of invoices) {
    await tx`UPDATE ca_invoices SET batch_id = ${batch.id} WHERE id = ${invoice.id}`;
  }
  await writeAudit(tx, ctx, { action: "ca_invoice_batch:generate", resourceType: "ca_invoice_batch", resourceId: batch.id, metadata: { invoiceCount: invoices.length, financeProjectId: projectId } });
  return { ...batch, invoiceCount: invoices.length };
}

// Email a batch with its invoice PDFs, then mark it and its invoices sent.
export async function sendCaBatch(
  tx: SQL,
  ctx: AuthCtx,
  batchId: string,
  { recipientEmail, subject, body }: { recipientEmail: string; subject: string; body: string },
) {
  const [batch] = await tx`SELECT id, status FROM ca_invoice_batches WHERE id = ${batchId}`;
  if (!batch) throw new HttpError(404, "not found");
  if (batch.status === "sent") throw new HttpError(400, "already sent");

  const batchInvoices = await tx`
    SELECT invoice_number, invoice_date, currency, amount_cents FROM ca_invoices WHERE batch_id = ${batchId}
  `;
  const attachments = await Promise.all(
    batchInvoices.map(async (inv: any) => ({
      filename: `${inv.invoice_number}.pdf`,
      content: await renderInvoicePdf({
        invoiceNumber: inv.invoice_number,
        invoiceDate: new Date(inv.invoice_date),
        amountCents: Number(inv.amount_cents),
        currency: inv.currency,
      }),
      contentType: "application/pdf",
    }))
  );

  await sendEmail(recipientEmail, subject, body.replace(/\n/g, "<br>"), attachments);

  await tx`
    UPDATE ca_invoice_batches SET status = 'sent', sent_at = now(), recipient_email = ${recipientEmail}, draft_subject = ${subject}, draft_body = ${body}
    WHERE id = ${batchId}
  `;
  await tx`UPDATE ca_invoices SET sent_at = now(), recipient_email = ${recipientEmail} WHERE batch_id = ${batchId}`;
  await writeAudit(tx, ctx, { action: "ca_invoice_batch:send", resourceType: "ca_invoice_batch", resourceId: batchId, metadata: { invoiceCount: batchInvoices.length, recipientEmail } });
}
