import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

// Tier 1 money + document reports. Scheduled per user from the catalog
// (r13.subs, n9.bills, r10.budget, r2.docs); all I/O lives in activities.
const { buildSubscriptionsReport, buildBillForecast, buildBudgetReport, buildDocumentExpiryReport, buildNetWorthReport } =
  routedActivities({
    startToCloseTimeout: "2 minutes",
    retry: { maximumAttempts: 2 },
  });

interface ReportInput { userId: string; routeKey: string }

export async function subscriptionsWorkflow(input: ReportInput) {
  return buildSubscriptionsReport(input);
}
export async function billForecastWorkflow(input: ReportInput & { days?: number }) {
  return buildBillForecast(input);
}
export async function budgetReportWorkflow(input: ReportInput) {
  return buildBudgetReport(input);
}
export async function netWorthWorkflow(input: ReportInput) {
  return buildNetWorthReport(input);
}
export async function documentExpiryWorkflow(input: ReportInput) {
  return buildDocumentExpiryReport(input);
}
