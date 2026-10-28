import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import { routedActivities } from "./task-queues.js";

const { remindUpcomingInterviewRounds } = routedActivities({
  startToCloseTimeout: "90 seconds",
  retry: { maximumAttempts: 2, initialInterval: "10s" },
});

export async function interviewRemindersWorkflow(input: {
  withinHours?: number;
  renotifyHours?: number;
  routeKey?: string;
} = {}): Promise<{ due: number; notified: number; failed: number }> {
  return remindUpcomingInterviewRounds(input);
}
