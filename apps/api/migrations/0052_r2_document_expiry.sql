-- R2: document expiry reuses Reminders (decision 2026-10-27). New 'document'
-- category for passport / licence / PUC; insurance and vehicle already exist.
-- Titles only — keep document numbers out of reminders.
ALTER TABLE reminders DROP CONSTRAINT reminders_category_check;
ALTER TABLE reminders ADD CONSTRAINT reminders_category_check
  CHECK (category IN ('bill','insurance','loan','credit_card','vehicle','document','other'));

-- Daily 09:00: escalating alerts at 60, 30, 15 and 7 days, then daily for the
-- last 3 days and on the day, for document / insurance / vehicle reminders.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('r2.docs', 'Document expiry',
   'Alerts at 60, 30, 15 and 7 days before a document, insurance or vehicle reminder expires, then daily in the last 3 days. Add them in Reminders.',
   '{reminders:read,slack:send}', 'cron:0 9 * * *', 'life',
   '{"workflowType":"documentExpiryWorkflow","cron":"0 9 * * *","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
