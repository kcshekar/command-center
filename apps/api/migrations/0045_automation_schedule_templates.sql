-- P3: per-user schedules come from the catalog, not from init-schedules.ts.
--
-- schedule_template (NULL = no per-user schedule: event/manual automations,
-- or org-wide sweeps that stay in init-schedules.ts as "system" schedules):
--   workflowType  Temporal workflow to start
--   cron          5-field cron, evaluated in SCHEDULE_TIMEZONE (IST default)
--   perAccount    true → one schedule per pinned Google account
--   args          workflow input; "$userId" / "$email" / "$digest" /
--                 "$approval" are filled in by CC (core/automation-schedules.ts)
--
-- Enabling a grant creates schedule ids "<automationId>:<userId>" or
-- "<automationId>:<userId>:<email>"; disabling pauses them. Args mirror what
-- init-schedules.ts passed before, so worker workflows are unchanged.

ALTER TABLE automation_catalog ADD COLUMN schedule_template jsonb;

INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area) VALUES
  ('a0.brief', 'Morning brief',
   'Daily 07:30 digest of today''s calendar, open Google Tasks and reminders due this week.',
   '{slack:send,reminders:read}', 'cron:30 7 * * *', 'life'),
  ('a0.wrap',  'Evening wrap',
   'Daily 20:00 recap of completed tasks; rolls overdue Google Tasks to tomorrow.',
   '{slack:send}', 'cron:0 20 * * *', 'life')
ON CONFLICT (id) DO NOTHING;

UPDATE automation_catalog SET schedule_template = '{"workflowType":"morningBriefWorkflow","cron":"30 7 * * *","perAccount":true,
  "args":{"userEmail":"$email","slackRouteKey":"$digest"}}' WHERE id = 'a0.brief';
UPDATE automation_catalog SET schedule_template = '{"workflowType":"eveningWrapWorkflow","cron":"0 20 * * *","perAccount":true,
  "args":{"userEmail":"$email","slackRouteKey":"$digest"}}' WHERE id = 'a0.wrap';
UPDATE automation_catalog SET schedule_template = '{"workflowType":"inboxTriageWorkflow","cron":"*/15 * * * *","perAccount":true,
  "args":{"userEmail":"$email","digestRouteKey":"$digest","approvalRouteKey":"$approval","userId":"$userId"}}' WHERE id = 'a5.mail';
UPDATE automation_catalog SET schedule_template = '{"workflowType":"calendarInterviewSyncWorkflow","cron":"0 * * * *","perAccount":true,
  "args":{"userId":"$userId","userEmail":"$email","daysAhead":30}}' WHERE id = 'a4.tracker';
UPDATE automation_catalog SET schedule_template = '{"workflowType":"newsIngestWorkflow","cron":"0 9 * * 1,4",
  "args":{"userId":"$userId","limit":15,"classify":true,"draft":true,"minImportance":4,"routeKey":"$digest"}}' WHERE id = 'a1.news';
UPDATE automation_catalog SET schedule_template = '{"workflowType":"jobsIngestWorkflow","cron":"0 9,18 * * *",
  "args":{"userId":"$userId","resultsPerPage":25,"classify":true,"draft":true,"minScore":4,"routeKey":"$digest"}}' WHERE id = 'a2.jobs';
UPDATE automation_catalog SET schedule_template = '{"workflowType":"profileRefreshWorkflow","cron":"0 10 1 * *",
  "args":{"userId":"$userId","recentDays":30,"routeKey":"$digest"}}' WHERE id = 'a7.profile';
UPDATE automation_catalog SET schedule_template = '{"workflowType":"learningIngestWorkflow","cron":"0 8 * * 1",
  "args":{"userId":"$userId","daysBack":7,"perRepo":5,"classify":true,"draft":true,"routeKey":"$digest"}}' WHERE id = 'a8.learning';
