-- N12: monthly CA invoice email. Uses the existing CA batch flow (per project:
-- foreign-currency inward entries → invoices + locally drafted cover email).
-- On the 5th the worker prepares last month's batches and posts each as an
-- approval card (Slack + Inbox); nothing is emailed until you approve.
-- Recipient = the CA address you used on that project's last sent batch.
UPDATE worker_clients
   SET allowed_scopes = array_append(allowed_scopes, 'invoices:write')
 WHERE 'expenses:write' = ANY(allowed_scopes)
   AND NOT ('invoices:write' = ANY(allowed_scopes));

INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('n12.ca', 'CA invoices',
   'On the 5th: last month''s export invoices per project, bundled with a drafted cover email to your CA. You get a summary to approve in Slack or the Inbox; it is only sent when you approve.',
   '{invoices:write,slack:send}', 'cron:0 10 5 * *', 'money',
   '{"workflowType":"caInvoicesWorkflow","cron":"0 10 5 * *","args":{"userId":"$userId","approvalRouteKey":"$approval","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
