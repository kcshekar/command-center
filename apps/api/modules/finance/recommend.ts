import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";

// Rule-based, not ML — thresholds are the whole engine. Deliberately simple:
// upgrade path if this ever needs real portfolio modeling is a separate
// service, not more rules bolted on here.
//
// income      = inward ledger entries (project/client payments) in the window
// expenses    = daily expenses + recurring bills (normalized to the window) +
//               outward ledger entries + CA payments + tax records
// One known gap: a payroll run only shows up here if it created a linked
// outward ledger entry (Phase 5's optional financeProjectId) — a payroll run
// with no linked project is invisible to this calculation.
interface Recommendation {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
}

function toMajorUnits(cents: number): string {
  return (cents / 100).toFixed(2);
}

export const recommendRoutes = {
  "/api/finance/recommendations": {
    GET: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const months = Number(new URL(req.url).searchParams.get("months") ?? 3);

      const [[income], [outward], [expenseTotal], [bills], [ca], [tax], categoryRows] = await Promise.all([
        ctx.tx`
          SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM ledger_entries
          WHERE direction = 'inward' AND occurred_on >= (CURRENT_DATE - (${months}::int * INTERVAL '1 month'))
        `,
        ctx.tx`
          SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM ledger_entries
          WHERE direction = 'outward' AND occurred_on >= (CURRENT_DATE - (${months}::int * INTERVAL '1 month'))
        `,
        ctx.tx`
          SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM expenses
          WHERE occurred_on >= (CURRENT_DATE - (${months}::int * INTERVAL '1 month'))
        `,
        ctx.tx`
          SELECT COALESCE(SUM(
            CASE cadence WHEN 'monthly' THEN amount_cents WHEN 'yearly' THEN amount_cents / 12 WHEN 'weekly' THEN amount_cents * 4 END
          ), 0)::bigint AS monthly_equivalent_cents
          FROM recurring_bills WHERE active = true
        `,
        ctx.tx`
          SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM ca_payments
          WHERE paid_on >= (CURRENT_DATE - (${months}::int * INTERVAL '1 month'))
        `,
        ctx.tx`
          SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM tax_records
          WHERE paid_on >= (CURRENT_DATE - (${months}::int * INTERVAL '1 month'))
        `,
        ctx.tx`
          SELECT category, COALESCE(SUM(amount_cents), 0)::bigint AS total FROM expenses
          WHERE occurred_on >= (CURRENT_DATE - (${months}::int * INTERVAL '1 month'))
          GROUP BY category
        `,
      ]);

      const incomeCents = Number(income.total);
      const outwardCents = Number(outward.total);
      const expenseCents = Number(expenseTotal.total);
      const billsCents = Number(bills.monthly_equivalent_cents) * months;
      const caCents = Number(ca.total);
      const taxCents = Number(tax.total);
      const totalExpensesCents = outwardCents + expenseCents + billsCents + caCents + taxCents;
      const savingsCents = incomeCents - totalExpensesCents;
      const savingsRate = incomeCents > 0 ? savingsCents / incomeCents : null;

      const recommendations: Recommendation[] = [];

      if (incomeCents === 0) {
        recommendations.push({
          type: "no_income_data",
          severity: "info",
          message: `No inward payments recorded in the last ${months} month(s) — need income data to compute a savings rate.`,
        });
      } else if (savingsRate! < 0) {
        recommendations.push({
          type: "negative_savings",
          severity: "critical",
          message: `Expenses exceeded income by ${toMajorUnits(-savingsCents)} over the last ${months} month(s). Review outward payments and recurring bills.`,
        });
      } else if (savingsRate! < 0.1) {
        recommendations.push({
          type: "low_savings_rate",
          severity: "warning",
          message: `Savings rate is ${(savingsRate! * 100).toFixed(1)}%, below the 10% threshold. Consider reducing discretionary spending.`,
        });
      } else if (savingsRate! < 0.3) {
        recommendations.push({
          type: "healthy_savings_rate",
          severity: "info",
          message: `Savings rate is ${(savingsRate! * 100).toFixed(1)}%. Consider starting or increasing a SIP in a diversified index fund with the surplus.`,
        });
      } else {
        recommendations.push({
          type: "strong_savings_rate",
          severity: "info",
          message: `Savings rate is ${(savingsRate! * 100).toFixed(1)}%. Consider increasing equity/mutual fund allocation or diversifying into direct stocks beyond cash reserves.`,
        });
      }

      if (incomeCents > 0 && billsCents / incomeCents > 0.5) {
        recommendations.push({
          type: "high_fixed_costs",
          severity: "warning",
          message: `Recurring bills/subscriptions consume over 50% of income. Review for cancellable subscriptions.`,
        });
      }

      for (const c of categoryRows as any[]) {
        const total = Number(c.total);
        if (expenseCents > 0 && total / expenseCents > 0.4) {
          recommendations.push({
            type: "concentrated_expense_category",
            severity: "info",
            message: `"${c.category}" makes up over 40% of tracked expenses (${toMajorUnits(total)}). Consider reviewing this category.`,
          });
        }
      }

      return Response.json({
        periodMonths: months,
        incomeCents,
        totalExpensesCents,
        savingsCents,
        savingsRate,
        recommendations,
      });
    }),
  },
};
