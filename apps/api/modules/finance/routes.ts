import type { SQL } from "bun";
import { tenantRoute } from "../../core/router";
import { requireRole, assertOwnerOrGrant } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { HttpError, type AuthCtx } from "../../core/auth";
import { renderInvoicePdf, invoiceNumberFor } from "./ca-invoice-pdf";
import { draftText } from "../../core/ollama";
import { sendEmail } from "../../core/email";

async function assertFinanceProjectAccess(
  tx: SQL,
  ctx: AuthCtx,
  projectId: string,
  scope: "read" | "write" = "read"
) {
  const [project] = await tx`SELECT owner_id FROM finance_projects WHERE id = ${projectId}`;
  if (!project) throw new HttpError(404, "not found");
  await assertOwnerOrGrant(tx, ctx, "finance_project", projectId, project.owner_id, scope);
}

// Get-or-create the CA invoice row for one ledger entry. The invoice number
// is assigned once, on first call, and persisted — reused by both the
// single-entry download route and the monthly batch generator so an entry
// invoiced individually and later swept into a batch keeps the same number.
async function ensureInvoice(tx: SQL, ctx: AuthCtx, entry: { id: string; currency: string; amount_cents: number; occurred_on: string | Date }) {
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

export const financeRoutes = {
  // --- Accounts: company-wide, owner/admin only ---
  "/api/finance/accounts": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      return Response.json(await ctx.tx`SELECT id, name, kind FROM accounts ORDER BY name`);
    }),
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { name, kind } = await req.json();
      if (!name || !kind) throw new HttpError(400, "name and kind required");
      const [row] = await ctx.tx`
        INSERT INTO accounts (org_id, name, kind) VALUES (${ctx.orgId}, ${name}, ${kind}) RETURNING id, name, kind
      `;
      await writeAudit(ctx.tx, ctx, { action: "account:create", resourceType: "account", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },

  // --- Recurring bills: company-wide, owner/admin only ---
  "/api/finance/bills": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      // Whether a reminder already links back to this bill — shown inline so
      // it's obvious which recurring bills still need one set up.
      return Response.json(await ctx.tx`
        SELECT rb.id, rb.name, rb.amount_cents, rb.currency, rb.cadence, rb.due_day, rb.category, rb.active,
               min(r.due_on) AS reminder_due_on, count(r.id)::int AS reminder_count
        FROM recurring_bills rb LEFT JOIN reminders r ON r.resource_type = 'bill' AND r.resource_id = rb.id
        GROUP BY rb.id
        ORDER BY rb.name
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { name, amountCents, currency, cadence, dueDay, category } = await req.json();
      if (!name || amountCents == null || !cadence || !category) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO recurring_bills (org_id, name, amount_cents, currency, cadence, due_day, category)
        VALUES (${ctx.orgId}, ${name}, ${amountCents}, ${currency ?? "INR"}, ${cadence}, ${dueDay ?? null}, ${category})
        RETURNING id, name, amount_cents, currency, cadence, due_day, category
      `;
      await writeAudit(ctx.tx, ctx, { action: "bill:create", resourceType: "recurring_bill", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/bills/:billId": {
    // Accepts either a full edit (name/amountCents/etc.) or just {active} for
    // the quick pause/resume toggle — COALESCE means an omitted field keeps
    // its current value instead of being wiped.
    PUT: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { billId } = req.params;
      const { name, amountCents, currency, cadence, dueDay, category, active } = await req.json();
      const [row] = await ctx.tx`
        UPDATE recurring_bills SET
          name = COALESCE(${name ?? null}, name),
          amount_cents = COALESCE(${amountCents ?? null}, amount_cents),
          currency = COALESCE(${currency ?? null}, currency),
          cadence = COALESCE(${cadence ?? null}, cadence),
          due_day = COALESCE(${dueDay ?? null}, due_day),
          category = COALESCE(${category ?? null}, category),
          active = COALESCE(${active ?? null}, active)
        WHERE id = ${billId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "bill:update", resourceType: "recurring_bill", resourceId: billId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { billId } = req.params;
      const [row] = await ctx.tx`DELETE FROM recurring_bills WHERE id = ${billId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "bill:delete", resourceType: "recurring_bill", resourceId: billId });
      return new Response(null, { status: 204 });
    }),
  },

  // --- Expenses: company-wide, owner/admin only ---
  "/api/finance/expenses": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      return Response.json(await ctx.tx`
        SELECT e.id, e.account_id, e.amount_cents, e.currency, e.category, e.occurred_on, e.note,
               min(r.due_on) AS reminder_due_on, count(r.id)::int AS reminder_count
        FROM expenses e LEFT JOIN reminders r ON r.resource_type = 'expense' AND r.resource_id = e.id
        GROUP BY e.id
        ORDER BY e.occurred_on DESC
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { accountId, amountCents, currency, category, occurredOn, note } = await req.json();
      if (amountCents == null || !category || !occurredOn) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO expenses (org_id, account_id, amount_cents, currency, category, occurred_on, note)
        VALUES (${ctx.orgId}, ${accountId ?? null}, ${amountCents}, ${currency ?? "INR"}, ${category}, ${occurredOn}, ${note ?? null})
        RETURNING id, amount_cents, category, occurred_on
      `;
      await writeAudit(ctx.tx, ctx, { action: "expense:create", resourceType: "expense", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/expenses/:expenseId": {
    PUT: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { expenseId } = req.params;
      const { accountId, amountCents, currency, category, occurredOn, note } = await req.json();
      if (amountCents == null || !category || !occurredOn) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        UPDATE expenses SET
          account_id = ${accountId ?? null}, amount_cents = ${amountCents}, currency = ${currency ?? "INR"},
          category = ${category}, occurred_on = ${occurredOn}, note = ${note ?? null}
        WHERE id = ${expenseId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "expense:update", resourceType: "expense", resourceId: expenseId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { expenseId } = req.params;
      const [row] = await ctx.tx`DELETE FROM expenses WHERE id = ${expenseId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "expense:delete", resourceType: "expense", resourceId: expenseId });
      return new Response(null, { status: 204 });
    }),
  },
  // Chart-ready aggregation: sum by month + category over a trailing window.
  "/api/finance/expenses/summary": {
    GET: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const months = Number(new URL(req.url).searchParams.get("months") ?? 6);
      const rows = await ctx.tx`
        SELECT to_char(date_trunc('month', occurred_on), 'YYYY-MM') AS month, category, SUM(amount_cents)::bigint AS total_cents
        FROM expenses
        WHERE occurred_on >= (CURRENT_DATE - (${months}::int * INTERVAL '1 month'))
        GROUP BY 1, 2
        ORDER BY 1, 2
      `;
      return Response.json(rows);
    }),
  },

  // --- Finance projects: creator/owner/admin/grant, same pattern as secrets projects & vault items ---
  "/api/finance/projects": {
    GET: tenantRoute(async (_req, ctx) => {
      // Aggregated ledger totals in one query — a project card needs its
      // summary without triggering a per-project follow-up request. Sums
      // raw amount_cents across whatever currencies a project has, same
      // simplification the project detail page's own totals already make.
      return Response.json(await ctx.tx`
        SELECT p.id, p.name, p.owner_id, p.secrets_project_id, p.created_at,
               COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'inward'), 0)::bigint AS inward_cents,
               COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'outward'), 0)::bigint AS outward_cents,
               count(l.id)::int AS entry_count,
               max(l.occurred_on) AS last_entry_on
        FROM finance_projects p LEFT JOIN ledger_entries l ON l.finance_project_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      const { name, secretsProjectId } = await req.json();
      if (!name) throw new HttpError(400, "name required");
      const [row] = await ctx.tx`
        INSERT INTO finance_projects (org_id, owner_id, name, secrets_project_id)
        VALUES (${ctx.orgId}, ${ctx.userId}, ${name}, ${secretsProjectId ?? null})
        RETURNING id, name, created_at
      `;
      await writeAudit(ctx.tx, ctx, { action: "finance_project:create", resourceType: "finance_project", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/projects/:projectId": {
    GET: tenantRoute(async (req, ctx) => {
      const { projectId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "read");
      const [project] = await ctx.tx`SELECT id, name, owner_id, secrets_project_id FROM finance_projects WHERE id = ${projectId}`;
      const ledger = await ctx.tx`
        SELECT l.id, l.direction, l.amount_cents, l.currency, l.amount_inr_cents, l.counterparty, l.occurred_on, l.note,
               ci.invoice_number, ci.sent_at AS invoice_sent_at
        FROM ledger_entries l LEFT JOIN ca_invoices ci ON ci.ledger_entry_id = l.id
        WHERE l.finance_project_id = ${projectId} ORDER BY l.occurred_on DESC
      `;
      const inwardCents = ledger.filter((l: any) => l.direction === "inward").reduce((s: number, l: any) => s + Number(l.amount_cents), 0);
      const outwardCents = ledger.filter((l: any) => l.direction === "outward").reduce((s: number, l: any) => s + Number(l.amount_cents), 0);
      return Response.json({ ...project, ledger, inwardCents, outwardCents, netCents: inwardCents - outwardCents });
    }),
  },
  "/api/finance/projects/:projectId/ledger": {
    POST: tenantRoute(async (req, ctx) => {
      const { projectId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "write");
      const { direction, amountCents, currency, amountInrCents, counterparty, occurredOn, note } = await req.json();
      if (!direction || amountCents == null || !counterparty || !occurredOn) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO ledger_entries (org_id, finance_project_id, direction, amount_cents, currency, amount_inr_cents, counterparty, occurred_on, note, created_by)
        VALUES (${ctx.orgId}, ${projectId}, ${direction}, ${amountCents}, ${currency ?? "INR"}, ${amountInrCents ?? null}, ${counterparty}, ${occurredOn}, ${note ?? null}, ${ctx.userId})
        RETURNING id, direction, amount_cents, currency, amount_inr_cents, occurred_on
      `;
      await writeAudit(ctx.tx, ctx, { action: "ledger:create", resourceType: "ledger_entry", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/projects/:projectId/ledger/:entryId": {
    PUT: tenantRoute(async (req, ctx) => {
      const { projectId, entryId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "write");
      const { direction, amountCents, currency, amountInrCents, counterparty, occurredOn, note } = await req.json();
      if (!direction || amountCents == null || !counterparty || !occurredOn) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        UPDATE ledger_entries SET
          direction = ${direction}, amount_cents = ${amountCents}, currency = ${currency ?? "INR"},
          amount_inr_cents = ${amountInrCents ?? null}, counterparty = ${counterparty},
          occurred_on = ${occurredOn}, note = ${note ?? null}
        WHERE id = ${entryId} AND finance_project_id = ${projectId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "ledger:update", resourceType: "ledger_entry", resourceId: entryId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const { projectId, entryId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "write");
      const [row] = await ctx.tx`
        DELETE FROM ledger_entries WHERE id = ${entryId} AND finance_project_id = ${projectId} RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "ledger:delete", resourceType: "ledger_entry", resourceId: entryId });
      return new Response(null, { status: 204 });
    }),
  },

  // --- CA export invoices: PDF generated on the fly (nothing stored) from a
  // fixed HTML template + the ledger entry's own data. Only inward, non-INR
  // entries in one project's ledger qualify — that's what "export invoice"
  // means here. The invoice number is assigned once, on first generation,
  // and persisted so re-downloading later never changes it. ---
  "/api/finance/projects/:projectId/ledger/:entryId/invoice-pdf": {
    GET: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { projectId, entryId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "read");
      const [entry] = await ctx.tx`
        SELECT id, direction, amount_cents, currency, occurred_on
        FROM ledger_entries WHERE id = ${entryId} AND finance_project_id = ${projectId}
      `;
      if (!entry) throw new HttpError(404, "not found");
      if (entry.direction !== "inward" || entry.currency === "INR") {
        throw new HttpError(400, "invoices are only generated for foreign-currency inward entries");
      }

      const invoice = await ensureInvoice(ctx.tx, ctx, entry);

      const pdf = await renderInvoicePdf({
        invoiceNumber: invoice.invoice_number,
        invoiceDate: new Date(invoice.invoice_date),
        amountCents: Number(invoice.amount_cents),
        currency: invoice.currency,
      });
      return new Response(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${invoice.invoice_number}.pdf"`,
        },
      });
    }),
  },
  // Single-invoice send — no batch involved, for the common case of billing
  // one client for one entry right away instead of waiting for the monthly
  // sweep. Each ledger row's own invoice status (not invoiced / draft /
  // sent) is shown inline in the ledger table itself now, so there's no
  // separate flat invoices list to keep in sync with it any more.
  "/api/finance/projects/:projectId/ledger/:entryId/send-invoice": {
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { projectId, entryId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "write");
      const { recipientEmail, subject, body } = await req.json();
      if (!recipientEmail || !subject || !body) throw new HttpError(400, "missing fields");

      const [entry] = await ctx.tx`
        SELECT id, direction, amount_cents, currency, occurred_on
        FROM ledger_entries WHERE id = ${entryId} AND finance_project_id = ${projectId}
      `;
      if (!entry) throw new HttpError(404, "not found");
      if (entry.direction !== "inward" || entry.currency === "INR") {
        throw new HttpError(400, "invoices are only generated for foreign-currency inward entries");
      }

      const invoice = await ensureInvoice(ctx.tx, ctx, entry);
      const pdf = await renderInvoicePdf({
        invoiceNumber: invoice.invoice_number,
        invoiceDate: new Date(invoice.invoice_date),
        amountCents: Number(invoice.amount_cents),
        currency: invoice.currency,
      });
      await sendEmail(recipientEmail, subject, body.replace(/\n/g, "<br>"), [
        { filename: `${invoice.invoice_number}.pdf`, content: pdf, contentType: "application/pdf" },
      ]);

      await ctx.tx`UPDATE ca_invoices SET sent_at = now(), recipient_email = ${recipientEmail} WHERE id = ${invoice.id}`;
      await writeAudit(ctx.tx, ctx, { action: "ca_invoice:send", resourceType: "ca_invoice", resourceId: invoice.id, metadata: { recipientEmail } });
      return Response.json({ ok: true, invoiceNumber: invoice.invoice_number });
    }),
  },

  // --- Monthly CA invoice batches: one email per month bundling that
  // month's foreign-currency inward invoices from ONE project's ledger.
  // Drafting (Ollama-written body) is separate from sending — nothing goes
  // out until a human reviews and confirms via the send endpoint. ---
  "/api/finance/projects/:projectId/ca-invoice-batches": {
    GET: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { projectId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "read");
      return Response.json(await ctx.tx`
        SELECT b.id, b.period_month, b.recipient_email, b.draft_subject, b.draft_body, b.status, b.sent_at,
               count(ci.id)::int AS invoice_count
        FROM ca_invoice_batches b LEFT JOIN ca_invoices ci ON ci.batch_id = b.id
        WHERE b.finance_project_id = ${projectId}
        GROUP BY b.id
        ORDER BY b.period_month DESC
      `);
    }),
  },
  "/api/finance/projects/:projectId/ca-invoice-batches/generate": {
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { projectId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "write");
      const { periodMonth } = await req.json();
      if (!/^\d{4}-\d{2}$/.test(periodMonth ?? "")) throw new HttpError(400, "periodMonth must be YYYY-MM");
      const firstOfMonth = `${periodMonth}-01`;

      const entries = await ctx.tx`
        SELECT id, currency, amount_cents, occurred_on, counterparty
        FROM ledger_entries
        WHERE finance_project_id = ${projectId} AND direction = 'inward' AND currency <> 'INR'
          AND occurred_on >= ${firstOfMonth}::date AND occurred_on < (${firstOfMonth}::date + INTERVAL '1 month')
        ORDER BY occurred_on
      `;
      if (entries.length === 0) throw new HttpError(400, "no foreign-currency inward entries found for that month");

      const invoices = [];
      for (const entry of entries) {
        const invoice = await ensureInvoice(ctx.tx, ctx, entry);
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
      const recipientEmail = process.env.CA_EMAIL ?? "";

      const [existingDraft] = await ctx.tx`
        SELECT id FROM ca_invoice_batches WHERE period_month = ${firstOfMonth}::date AND status = 'draft' AND finance_project_id = ${projectId}
      `;
      let batch;
      if (existingDraft) {
        [batch] = await ctx.tx`
          UPDATE ca_invoice_batches SET recipient_email = ${recipientEmail}, draft_subject = ${draftSubject}, draft_body = ${draftBody}
          WHERE id = ${existingDraft.id}
          RETURNING id, period_month, recipient_email, draft_subject, draft_body, status
        `;
      } else {
        [batch] = await ctx.tx`
          INSERT INTO ca_invoice_batches (org_id, finance_project_id, period_month, recipient_email, draft_subject, draft_body, created_by)
          VALUES (${ctx.orgId}, ${projectId}, ${firstOfMonth}::date, ${recipientEmail}, ${draftSubject}, ${draftBody}, ${ctx.userId})
          RETURNING id, period_month, recipient_email, draft_subject, draft_body, status
        `;
      }
      for (const invoice of invoices) {
        await ctx.tx`UPDATE ca_invoices SET batch_id = ${batch.id} WHERE id = ${invoice.id}`;
      }
      await writeAudit(ctx.tx, ctx, { action: "ca_invoice_batch:generate", resourceType: "ca_invoice_batch", resourceId: batch.id, metadata: { invoiceCount: invoices.length, financeProjectId: projectId } });
      return Response.json({ ...batch, invoiceCount: invoices.length });
    }),
  },
  "/api/finance/ca-invoice-batches/:batchId/send": {
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { batchId } = req.params;
      const { recipientEmail, subject, body } = await req.json();
      if (!recipientEmail || !subject || !body) throw new HttpError(400, "missing fields");

      const [batch] = await ctx.tx`SELECT id, status FROM ca_invoice_batches WHERE id = ${batchId}`;
      if (!batch) throw new HttpError(404, "not found");
      if (batch.status === "sent") throw new HttpError(400, "already sent");

      const batchInvoices = await ctx.tx`
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

      await ctx.tx`
        UPDATE ca_invoice_batches SET status = 'sent', sent_at = now(), recipient_email = ${recipientEmail}, draft_subject = ${subject}, draft_body = ${body}
        WHERE id = ${batchId}
      `;
      await ctx.tx`UPDATE ca_invoices SET sent_at = now(), recipient_email = ${recipientEmail} WHERE batch_id = ${batchId}`;
      await writeAudit(ctx.tx, ctx, { action: "ca_invoice_batch:send", resourceType: "ca_invoice_batch", resourceId: batchId, metadata: { invoiceCount: batchInvoices.length, recipientEmail } });
      return Response.json({ ok: true });
    }),
  },

  // --- Employees: owner/admin manage; a part-time employee sees only their own payroll (below) ---
  "/api/finance/employees": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      return Response.json(await ctx.tx`
        SELECT id, user_id, name, employment_type, hourly_rate_cents, active FROM employees ORDER BY name
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { userId, name, employmentType, hourlyRateCents } = await req.json();
      if (!name) throw new HttpError(400, "name required");
      const [row] = await ctx.tx`
        INSERT INTO employees (org_id, user_id, name, employment_type, hourly_rate_cents)
        VALUES (${ctx.orgId}, ${userId ?? null}, ${name}, ${employmentType ?? "part_time"}, ${hourlyRateCents ?? null})
        RETURNING id, name, employment_type
      `;
      await writeAudit(ctx.tx, ctx, { action: "employee:create", resourceType: "employee", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/employees/:employeeId": {
    PUT: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { employeeId } = req.params;
      const { name, employmentType, hourlyRateCents, active } = await req.json();
      const [row] = await ctx.tx`
        UPDATE employees SET
          name = COALESCE(${name ?? null}, name),
          employment_type = COALESCE(${employmentType ?? null}, employment_type),
          hourly_rate_cents = COALESCE(${hourlyRateCents ?? null}, hourly_rate_cents),
          active = COALESCE(${active ?? null}, active)
        WHERE id = ${employeeId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "employee:update", resourceType: "employee", resourceId: employeeId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { employeeId } = req.params;
      const [row] = await ctx.tx`DELETE FROM employees WHERE id = ${employeeId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "employee:delete", resourceType: "employee", resourceId: employeeId });
      return new Response(null, { status: 204 });
    }),
  },

  // --- Payroll: create/list-all is owner/admin only; /me is any authenticated user, scoped to
  // their own employee record. Optionally records the outward ledger payment in the SAME
  // transaction as the payroll_runs insert — either both commit or neither does (financial
  // integrity mandate), verified by payroll_atomicity_check.ts against a real bad finance_project_id.
  "/api/finance/payroll-runs": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      return Response.json(await ctx.tx`
        SELECT id, employee_id, period_start, period_end, gross_cents, tax_withheld_cents, net_cents, paid_at
        FROM payroll_runs ORDER BY period_start DESC
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { employeeId, periodStart, periodEnd, grossCents, taxWithheldCents, financeProjectId, counterparty } = await req.json();
      if (!employeeId || !periodStart || !periodEnd || grossCents == null) throw new HttpError(400, "missing fields");
      const netCents = grossCents - (taxWithheldCents ?? 0);

      let ledgerEntryId: string | null = null;
      if (financeProjectId) {
        const [entry] = await ctx.tx`
          INSERT INTO ledger_entries (org_id, finance_project_id, direction, amount_cents, counterparty, occurred_on, created_by)
          VALUES (${ctx.orgId}, ${financeProjectId}, 'outward', ${netCents}, ${counterparty ?? "payroll"}, ${periodEnd}, ${ctx.userId})
          RETURNING id
        `;
        ledgerEntryId = entry.id;
      }

      const [run] = await ctx.tx`
        INSERT INTO payroll_runs (org_id, employee_id, period_start, period_end, gross_cents, tax_withheld_cents, net_cents, ledger_entry_id, paid_at)
        VALUES (${ctx.orgId}, ${employeeId}, ${periodStart}, ${periodEnd}, ${grossCents}, ${taxWithheldCents ?? 0}, ${netCents}, ${ledgerEntryId}, now())
        RETURNING id, net_cents
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "payroll:create",
        resourceType: "payroll_run",
        resourceId: run.id,
        metadata: { ledgerEntryId },
      });
      return Response.json(run, { status: 201 });
    }),
  },
  "/api/finance/payroll-runs/:runId": {
    // Net is always recomputed server-side, never accepted from the client —
    // same invariant the payroll_runs CHECK constraint enforces at the DB
    // level. Does not touch a linked ledger entry's amount on edit (the
    // ledger entry is a separate, dated, already-recorded transaction);
    // editing a paid run to change its numbers after the fact is unusual
    // enough that "go fix the ledger entry too, on purpose" is the right
    // default rather than silently rewriting money history.
    PUT: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { runId } = req.params;
      const { periodStart, periodEnd, grossCents, taxWithheldCents } = await req.json();
      if (!periodStart || !periodEnd || grossCents == null) throw new HttpError(400, "missing fields");
      const netCents = grossCents - (taxWithheldCents ?? 0);
      const [row] = await ctx.tx`
        UPDATE payroll_runs SET
          period_start = ${periodStart}, period_end = ${periodEnd},
          gross_cents = ${grossCents}, tax_withheld_cents = ${taxWithheldCents ?? 0}, net_cents = ${netCents}
        WHERE id = ${runId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "payroll:update", resourceType: "payroll_run", resourceId: runId });
      return Response.json({ ok: true });
    }),
    // Deletes the run's own linked ledger entry too (if any) in the same
    // transaction — mirrors the atomicity the create path already commits
    // to: a payroll run and its ledger record live and die together.
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { runId } = req.params;
      const [row] = await ctx.tx`DELETE FROM payroll_runs WHERE id = ${runId} RETURNING id, ledger_entry_id`;
      if (!row) throw new HttpError(404, "not found");
      if (row.ledger_entry_id) {
        await ctx.tx`DELETE FROM ledger_entries WHERE id = ${row.ledger_entry_id}`;
      }
      await writeAudit(ctx.tx, ctx, { action: "payroll:delete", resourceType: "payroll_run", resourceId: runId });
      return new Response(null, { status: 204 });
    }),
  },
  "/api/finance/payroll-runs/me": {
    GET: tenantRoute(async (_req, ctx) => {
      const [employee] = await ctx.tx`SELECT id FROM employees WHERE user_id = ${ctx.userId}`;
      if (!employee) return Response.json([]);
      return Response.json(await ctx.tx`
        SELECT id, period_start, period_end, gross_cents, tax_withheld_cents, net_cents, paid_at
        FROM payroll_runs WHERE employee_id = ${employee.id} ORDER BY period_start DESC
      `);
    }),
  },

  // --- Tax + CA payments: owner/admin only ---
  "/api/finance/ca-payments": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      return Response.json(await ctx.tx`SELECT id, amount_cents, purpose, paid_on FROM ca_payments ORDER BY paid_on DESC`);
    }),
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { amountCents, purpose, paidOn } = await req.json();
      if (amountCents == null || !paidOn) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO ca_payments (org_id, amount_cents, purpose, paid_on) VALUES (${ctx.orgId}, ${amountCents}, ${purpose ?? null}, ${paidOn})
        RETURNING id, amount_cents, purpose, paid_on
      `;
      await writeAudit(ctx.tx, ctx, { action: "ca_payment:create", resourceType: "ca_payment", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/ca-payments/:paymentId": {
    PUT: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { paymentId } = req.params;
      const { amountCents, purpose, paidOn } = await req.json();
      if (amountCents == null || !paidOn) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        UPDATE ca_payments SET amount_cents = ${amountCents}, purpose = ${purpose ?? null}, paid_on = ${paidOn}
        WHERE id = ${paymentId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "ca_payment:update", resourceType: "ca_payment", resourceId: paymentId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { paymentId } = req.params;
      const [row] = await ctx.tx`DELETE FROM ca_payments WHERE id = ${paymentId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "ca_payment:delete", resourceType: "ca_payment", resourceId: paymentId });
      return new Response(null, { status: 204 });
    }),
  },
  "/api/finance/tax-records": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      return Response.json(await ctx.tx`
        SELECT id, tax_year, category, amount_cents, paid_on, ca_payment_id FROM tax_records ORDER BY tax_year DESC
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { taxYear, category, amountCents, paidOn, caPaymentId } = await req.json();
      if (!taxYear || !category || amountCents == null) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO tax_records (org_id, tax_year, category, amount_cents, paid_on, ca_payment_id)
        VALUES (${ctx.orgId}, ${taxYear}, ${category}, ${amountCents}, ${paidOn ?? null}, ${caPaymentId ?? null})
        RETURNING id, tax_year, category, amount_cents
      `;
      await writeAudit(ctx.tx, ctx, { action: "tax_record:create", resourceType: "tax_record", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/tax-records/:recordId": {
    PUT: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { recordId } = req.params;
      const { taxYear, category, amountCents, paidOn, caPaymentId } = await req.json();
      if (!taxYear || !category || amountCents == null) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        UPDATE tax_records SET
          tax_year = ${taxYear}, category = ${category}, amount_cents = ${amountCents},
          paid_on = ${paidOn ?? null}, ca_payment_id = ${caPaymentId ?? null}
        WHERE id = ${recordId}
        RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "tax_record:update", resourceType: "tax_record", resourceId: recordId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { recordId } = req.params;
      const [row] = await ctx.tx`DELETE FROM tax_records WHERE id = ${recordId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "tax_record:delete", resourceType: "tax_record", resourceId: recordId });
      return new Response(null, { status: 204 });
    }),
  },
};
