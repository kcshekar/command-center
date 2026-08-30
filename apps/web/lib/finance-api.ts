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
  reminder_due_on: string | null;
  reminder_count: number;
}
export interface Expense {
  id: string;
  account_id: string | null;
  amount_cents: number;
  currency: string;
  category: string;
  occurred_on: string;
  note: string | null;
  reminder_due_on: string | null;
  reminder_count: number;
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
  inward_cents: number;
  outward_cents: number;
  entry_count: number;
  last_entry_on: string | null;
}
export interface LedgerEntry {
  id: string;
  direction: "inward" | "outward";
  amount_cents: number;
  currency: string;
  amount_inr_cents: number | null;
  counterparty: string;
  occurred_on: string;
  note: string | null;
  invoice_number: string | null;
  invoice_sent_at: string | null;
}
export interface CaInvoiceBatch {
  id: string;
  period_month: string;
  recipient_email: string;
  draft_subject: string;
  draft_body: string;
  status: "draft" | "sent";
  sent_at: string | null;
  invoice_count: number;
}
export interface FinanceProjectDetail extends FinanceProject {
  ledger: LedgerEntry[];
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
  updateBill: (billId: string, params: { name: string; amountCents: number; currency?: string; cadence: string; dueDay?: number; category: string }) =>
    apiFetch(`/finance/bills/${billId}`, { method: "PUT", body: JSON.stringify(params) }),
  deleteBill: (billId: string) => apiFetch(`/finance/bills/${billId}`, { method: "DELETE" }),

  listExpenses: () => apiFetch<Expense[]>("/finance/expenses"),
  createExpense: (params: { accountId?: string; amountCents: number; currency?: string; category: string; occurredOn: string; note?: string }) =>
    apiFetch<Expense>("/finance/expenses", { method: "POST", body: JSON.stringify(params) }),
  updateExpense: (expenseId: string, params: { accountId?: string; amountCents: number; currency?: string; category: string; occurredOn: string; note?: string }) =>
    apiFetch(`/finance/expenses/${expenseId}`, { method: "PUT", body: JSON.stringify(params) }),
  deleteExpense: (expenseId: string) => apiFetch(`/finance/expenses/${expenseId}`, { method: "DELETE" }),
  expenseSummary: (months = 6) => apiFetch<ExpenseSummaryRow[]>(`/finance/expenses/summary?months=${months}`),

  listProjects: () => apiFetch<FinanceProject[]>("/finance/projects"),
  createProject: (params: { name: string; secretsProjectId?: string }) => apiFetch<FinanceProject>("/finance/projects", { method: "POST", body: JSON.stringify(params) }),
  getProject: (projectId: string) => apiFetch<FinanceProjectDetail>(`/finance/projects/${projectId}`),
  addLedgerEntry: (projectId: string, params: { direction: "inward" | "outward"; amountCents: number; currency?: string; amountInrCents?: number; counterparty: string; occurredOn: string; note?: string }) =>
    apiFetch(`/finance/projects/${projectId}/ledger`, { method: "POST", body: JSON.stringify(params) }),
  updateProjectLedgerEntry: (projectId: string, entryId: string, params: { direction: "inward" | "outward"; amountCents: number; currency?: string; amountInrCents?: number; counterparty: string; occurredOn: string; note?: string }) =>
    apiFetch(`/finance/projects/${projectId}/ledger/${entryId}`, { method: "PUT", body: JSON.stringify(params) }),
  deleteProjectLedgerEntry: (projectId: string, entryId: string) =>
    apiFetch(`/finance/projects/${projectId}/ledger/${entryId}`, { method: "DELETE" }),

  // CA export invoices: generated from one project's ledger. PDF is
  // generated on the fly (no storage) — this triggers a browser download
  // rather than returning JSON, so it bypasses apiFetch's JSON handling and
  // talks to fetch() directly.
  downloadInvoicePdf: async (projectId: string, entryId: string) => {
    const res = await fetch(`/api/finance/projects/${projectId}/ledger/${entryId}/invoice-pdf`);
    if (!res.ok) throw new Error("Failed to generate invoice PDF");
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="(.+)"/)?.[1] ?? "invoice.pdf";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  // Single-invoice send: one entry, one email, no batch involved.
  sendInvoice: (projectId: string, entryId: string, params: { recipientEmail: string; subject: string; body: string }) =>
    apiFetch<{ ok: true; invoiceNumber: string }>(`/finance/projects/${projectId}/ledger/${entryId}/send-invoice`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  // Monthly CA invoice batches: one email bundling that month's invoices
  // from one project's ledger.
  listCaInvoiceBatches: (projectId: string) => apiFetch<CaInvoiceBatch[]>(`/finance/projects/${projectId}/ca-invoice-batches`),
  generateCaInvoiceBatch: (projectId: string, periodMonth: string) =>
    apiFetch<CaInvoiceBatch>(`/finance/projects/${projectId}/ca-invoice-batches/generate`, { method: "POST", body: JSON.stringify({ periodMonth }) }),
  sendCaInvoiceBatch: (batchId: string, params: { recipientEmail: string; subject: string; body: string }) =>
    apiFetch(`/finance/ca-invoice-batches/${batchId}/send`, { method: "POST", body: JSON.stringify(params) }),

  listEmployees: () => apiFetch<Employee[]>("/finance/employees"),
  createEmployee: (params: { userId?: string; name: string; employmentType?: string; hourlyRateCents?: number }) =>
    apiFetch<Employee>("/finance/employees", { method: "POST", body: JSON.stringify(params) }),
  updateEmployee: (employeeId: string, params: { name: string; employmentType?: string; hourlyRateCents?: number; active?: boolean }) =>
    apiFetch(`/finance/employees/${employeeId}`, { method: "PUT", body: JSON.stringify(params) }),
  deleteEmployee: (employeeId: string) => apiFetch(`/finance/employees/${employeeId}`, { method: "DELETE" }),

  listPayrollRuns: () => apiFetch<PayrollRun[]>("/finance/payroll-runs"),
  myPayrollRuns: () => apiFetch<PayrollRun[]>("/finance/payroll-runs/me"),
  createPayrollRun: (params: { employeeId: string; periodStart: string; periodEnd: string; grossCents: number; taxWithheldCents?: number; financeProjectId?: string; counterparty?: string }) =>
    apiFetch<PayrollRun>("/finance/payroll-runs", { method: "POST", body: JSON.stringify(params) }),
  updatePayrollRun: (runId: string, params: { periodStart: string; periodEnd: string; grossCents: number; taxWithheldCents?: number }) =>
    apiFetch(`/finance/payroll-runs/${runId}`, { method: "PUT", body: JSON.stringify(params) }),
  deletePayrollRun: (runId: string) => apiFetch(`/finance/payroll-runs/${runId}`, { method: "DELETE" }),

  listCaPayments: () => apiFetch<CaPayment[]>("/finance/ca-payments"),
  createCaPayment: (params: { amountCents: number; purpose?: string; paidOn: string }) =>
    apiFetch<CaPayment>("/finance/ca-payments", { method: "POST", body: JSON.stringify(params) }),
  updateCaPayment: (paymentId: string, params: { amountCents: number; purpose?: string; paidOn: string }) =>
    apiFetch(`/finance/ca-payments/${paymentId}`, { method: "PUT", body: JSON.stringify(params) }),
  deleteCaPayment: (paymentId: string) => apiFetch(`/finance/ca-payments/${paymentId}`, { method: "DELETE" }),

  listTaxRecords: () => apiFetch<TaxRecord[]>("/finance/tax-records"),
  createTaxRecord: (params: { taxYear: number; category: string; amountCents: number; paidOn?: string; caPaymentId?: string }) =>
    apiFetch<TaxRecord>("/finance/tax-records", { method: "POST", body: JSON.stringify(params) }),
  updateTaxRecord: (recordId: string, params: { taxYear: number; category: string; amountCents: number; paidOn?: string; caPaymentId?: string }) =>
    apiFetch(`/finance/tax-records/${recordId}`, { method: "PUT", body: JSON.stringify(params) }),
  deleteTaxRecord: (recordId: string) => apiFetch(`/finance/tax-records/${recordId}`, { method: "DELETE" }),

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
