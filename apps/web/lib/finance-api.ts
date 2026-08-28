import { apiFetch } from "./api";

export interface Account {
  id: string;
  name: string;
  kind: string;
}
export interface RecurringBill {
  id: string;
  name: string;
  amount_cents: number;
  currency: string;
  cadence: string;
  due_day: number | null;
  category: string;
  active: boolean;
}
export interface Expense {
  id: string;
  account_id: string | null;
  amount_cents: number;
  currency: string;
  category: string;
  occurred_on: string;
  note: string | null;
}
export interface ExpenseSummaryRow {
  month: string;
  category: string;
  total_cents: string | number;
}
export interface FinanceProject {
  id: string;
  name: string;
  owner_id: string;
  secrets_project_id: string | null;
  created_at: string;
}
export interface FinanceProjectDetail extends FinanceProject {
  ledger: { id: string; direction: "inward" | "outward"; amount_cents: number; counterparty: string; occurred_on: string; note: string | null }[];
  inwardCents: number;
  outwardCents: number;
  netCents: number;
}
export interface Employee {
  id: string;
  user_id: string | null;
  name: string;
  employment_type: string;
  hourly_rate_cents: number | null;
  active: boolean;
}
export interface PayrollRun {
  id: string;
  employee_id: string;
  period_start: string;
  period_end: string;
  gross_cents: number;
  tax_withheld_cents: number;
  net_cents: number;
  paid_at: string | null;
}
export interface CaPayment {
  id: string;
  amount_cents: number;
  purpose: string | null;
  paid_on: string;
}
export interface TaxRecord {
  id: string;
  tax_year: number;
  category: string;
  amount_cents: number;
  paid_on: string | null;
  ca_payment_id: string | null;
}
export interface Recommendation {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
}
export interface RecommendationsResponse {
  periodMonths: number;
  incomeCents: number;
  totalExpensesCents: number;
  savingsCents: number;
  savingsRate: number | null;
  recommendations: Recommendation[];
}

export const financeApi = {
  listAccounts: () => apiFetch<Account[]>("/finance/accounts"),
  createAccount: (params: { name: string; kind: string }) => apiFetch<Account>("/finance/accounts", { method: "POST", body: JSON.stringify(params) }),

  listBills: () => apiFetch<RecurringBill[]>("/finance/bills"),
  createBill: (params: { name: string; amountCents: number; currency?: string; cadence: string; dueDay?: number; category: string }) =>
    apiFetch<RecurringBill>("/finance/bills", { method: "POST", body: JSON.stringify(params) }),
  setBillActive: (billId: string, active: boolean) => apiFetch(`/finance/bills/${billId}`, { method: "PUT", body: JSON.stringify({ active }) }),

  listExpenses: () => apiFetch<Expense[]>("/finance/expenses"),
  createExpense: (params: { accountId?: string; amountCents: number; currency?: string; category: string; occurredOn: string; note?: string }) =>
    apiFetch<Expense>("/finance/expenses", { method: "POST", body: JSON.stringify(params) }),
  expenseSummary: (months = 6) => apiFetch<ExpenseSummaryRow[]>(`/finance/expenses/summary?months=${months}`),

  listProjects: () => apiFetch<FinanceProject[]>("/finance/projects"),
  createProject: (params: { name: string; secretsProjectId?: string }) => apiFetch<FinanceProject>("/finance/projects", { method: "POST", body: JSON.stringify(params) }),
  getProject: (projectId: string) => apiFetch<FinanceProjectDetail>(`/finance/projects/${projectId}`),
  addLedgerEntry: (projectId: string, params: { direction: "inward" | "outward"; amountCents: number; counterparty: string; occurredOn: string; note?: string }) =>
    apiFetch(`/finance/projects/${projectId}/ledger`, { method: "POST", body: JSON.stringify(params) }),

  listEmployees: () => apiFetch<Employee[]>("/finance/employees"),
  createEmployee: (params: { userId?: string; name: string; employmentType?: string; hourlyRateCents?: number }) =>
    apiFetch<Employee>("/finance/employees", { method: "POST", body: JSON.stringify(params) }),

  listPayrollRuns: () => apiFetch<PayrollRun[]>("/finance/payroll-runs"),
  myPayrollRuns: () => apiFetch<PayrollRun[]>("/finance/payroll-runs/me"),
  createPayrollRun: (params: { employeeId: string; periodStart: string; periodEnd: string; grossCents: number; taxWithheldCents?: number; financeProjectId?: string; counterparty?: string }) =>
    apiFetch<PayrollRun>("/finance/payroll-runs", { method: "POST", body: JSON.stringify(params) }),

  listCaPayments: () => apiFetch<CaPayment[]>("/finance/ca-payments"),
  createCaPayment: (params: { amountCents: number; purpose?: string; paidOn: string }) =>
    apiFetch<CaPayment>("/finance/ca-payments", { method: "POST", body: JSON.stringify(params) }),

  listTaxRecords: () => apiFetch<TaxRecord[]>("/finance/tax-records"),
  createTaxRecord: (params: { taxYear: number; category: string; amountCents: number; paidOn?: string; caPaymentId?: string }) =>
    apiFetch<TaxRecord>("/finance/tax-records", { method: "POST", body: JSON.stringify(params) }),

  recommendations: (months = 3) => apiFetch<RecommendationsResponse>(`/finance/recommendations?months=${months}`),
};

export function formatCents(cents: number | string, currency = "INR"): string {
  const n = Number(cents) / 100;
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

// Postgres `date` columns serialize to full ISO timestamps
// ("2026-08-01T00:00:00.000Z") over JSON — this trims to just the date part
// for display.
export function formatDate(dateString: string): string {
  return dateString.slice(0, 10);
}
