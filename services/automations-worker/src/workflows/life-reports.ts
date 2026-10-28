import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

// Life tracker reports (catalog r11.habits, r7.groceries, r9.vehicle).
const { buildHabitCheckin, buildGroceryList, buildVehicleReport } = routedActivities({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

interface ReportInput { userId: string; routeKey: string }

export async function habitCheckinWorkflow(input: ReportInput) {
  return buildHabitCheckin(input);
}
export async function groceryListWorkflow(input: ReportInput) {
  return buildGroceryList(input);
}
export async function vehicleReportWorkflow(input: ReportInput) {
  return buildVehicleReport(input);
}
