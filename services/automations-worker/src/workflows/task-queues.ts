import { proxyActivities, type ActivityInterfaceFor, type ActivityOptions } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

// P1.0c: per-API task queues, so a Google 429 storm or a slow Ollama queue
// can't starve unrelated automations. worker.ts runs one activity worker per
// queue with its own limits; anything not routed here stays on the main queue
// (TEMPORAL_TASK_QUEUE). Route by the activity's MAIN external call. Long mixed
// ingests (HN, learning feeds) stay on main: Ollama is serialised by the
// in-process mutex anyway, and parking them on ollama-local (concurrency 1)
// would hold inbox triage behind a 6-minute sweep.
export const TASK_QUEUES = { google: "google-api", jobs: "external-jobs-api", ollama: "ollama-local" } as const;

const ROUTES: Partial<Record<keyof typeof activities, string>> = {
  fetchCalendarEvents: TASK_QUEUES.google,
  fetchGoogleTasks: TASK_QUEUES.google,
  fetchGmailHistory: TASK_QUEUES.google,
  trashGmailMessages: TASK_QUEUES.google,
  fetchCompletedTasksToday: TASK_QUEUES.google,
  rolloverOverdueTasks: TASK_QUEUES.google,
  fetchGmailMessageFull: TASK_QUEUES.google,
  sendGmailReply: TASK_QUEUES.google,
  syncGoogleCalendarInterviews: TASK_QUEUES.google,
  buildMeetingPrep: TASK_QUEUES.google,

  ingestAdzunaJobs: TASK_QUEUES.jobs,

  classifyEmailOllama: TASK_QUEUES.ollama,
  classifyNewsItem: TASK_QUEUES.ollama,
  classifyLessonItem: TASK_QUEUES.ollama,
  ingestBillReminder: TASK_QUEUES.ollama,
  ingestInterviewSchedulingEmail: TASK_QUEUES.ollama,
  ingestTravelBookingEmail: TASK_QUEUES.ollama,
  draftAffirmation: TASK_QUEUES.ollama,
  draftReplyToEmail: TASK_QUEUES.ollama,
  draftAndPostNewsBrief: TASK_QUEUES.ollama,
  draftAndPostLearningDigest: TASK_QUEUES.ollama,
  draftAndPostJobsDigest: TASK_QUEUES.ollama,
  refreshProfileDrafts: TASK_QUEUES.ollama,
  researchJobLeadForInterview: TASK_QUEUES.ollama,
  researchCompanyForInterview: TASK_QUEUES.ollama,
  reactAgentActivity: TASK_QUEUES.ollama,
  tailorResumeForJobLead: TASK_QUEUES.ollama,
  buildOccasionsReport: TASK_QUEUES.ollama,
};

/** Drop-in for proxyActivities<typeof activities>(opts) that sends each activity to its routed queue. */
export function routedActivities(opts: ActivityOptions): ActivityInterfaceFor<typeof activities> {
  const byQueue = new Map<string, Record<string, unknown>>();
  return new Proxy({} as ActivityInterfaceFor<typeof activities>, {
    get(_, name) {
      const queue = ROUTES[name as keyof typeof activities] ?? "";
      if (!byQueue.has(queue)) byQueue.set(queue, proxyActivities(queue ? { ...opts, taskQueue: queue } : opts));
      return byQueue.get(queue)![name as string];
    },
  });
}
