import type { SQL } from "bun";
import { tenantRoute } from "../../core/router";
import { requireRole, assertOwnerOrGrant } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { HttpError, type AuthCtx } from "../../core/auth";

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
      return Response.json(row, { status: 201 });
    }),
  },

  // --- Recurring bills: company-wide, owner/admin only ---
  "/api/finance/bills": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      return Response.json(await ctx.tx`
        SELECT id, name, amount_cents, currency, cadence, due_day, category, active
        FROM recurring_bills ORDER BY name
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
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/bills/:billId": {
    PUT: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { billId } = req.params;
      const { active } = await req.json();
      const [row] = await ctx.tx`
        UPDATE recurring_bills SET active = ${active} WHERE id = ${billId} RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      return Response.json({ ok: true });
    }),
  },

  // --- Expenses: company-wide, owner/admin only ---
  "/api/finance/expenses": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      return Response.json(await ctx.tx`
        SELECT id, account_id, amount_cents, currency, category, occurred_on, note
        FROM expenses ORDER BY occurred_on DESC
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
      return Response.json(row, { status: 201 });
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
      return Response.json(await ctx.tx`SELECT id, name, owner_id, secrets_project_id, created_at FROM finance_projects ORDER BY created_at`);
    }),
    POST: tenantRoute(async (req, ctx) => {
      const { name, secretsProjectId } = await req.json();
      if (!name) throw new HttpError(400, "name required");
      const [row] = await ctx.tx`
        INSERT INTO finance_projects (org_id, owner_id, name, secrets_project_id)
        VALUES (${ctx.orgId}, ${ctx.userId}, ${name}, ${secretsProjectId ?? null})
        RETURNING id, name, created_at
      `;
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/finance/projects/:projectId": {
    GET: tenantRoute(async (req, ctx) => {
      const { projectId } = req.params;
      await assertFinanceProjectAccess(ctx.tx, ctx, projectId, "read");
      const [project] = await ctx.tx`SELECT id, name, owner_id, secrets_project_id FROM finance_projects WHERE id = ${projectId}`;
      const ledger = await ctx.tx`
        SELECT id, direction, amount_cents, counterparty, occurred_on, note
        FROM ledger_entries WHERE finance_project_id = ${projectId} ORDER BY occurred_on DESC
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
      const { direction, amountCents, counterparty, occurredOn, note } = await req.json();
      if (!direction || amountCents == null || !counterparty || !occurredOn) throw new HttpError(400, "missing fields");
      const [row] = await ctx.tx`
        INSERT INTO ledger_entries (org_id, finance_project_id, direction, amount_cents, counterparty, occurred_on, note, created_by)
        VALUES (${ctx.orgId}, ${projectId}, ${direction}, ${amountCents}, ${counterparty}, ${occurredOn}, ${note ?? null}, ${ctx.userId})
        RETURNING id, direction, amount_cents, occurred_on
      `;
      await writeAudit(ctx.tx, ctx, { action: "ledger:create", resourceType: "ledger_entry", resourceId: row.id });
      return Response.json(row, { status: 201 });
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
      return Response.json(row, { status: 201 });
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
      await writeAudit(ctx.tx, ctx, { action: "payroll:create", resourceType: "payroll_run", resourceId: run.id });
      return Response.json(run, { status: 201 });
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
      return Response.json(row, { status: 201 });
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
      return Response.json(row, { status: 201 });
    }),
  },
};
