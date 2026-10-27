-- R13: subscriptions. Yearly bills stored only a day, so their renewal date
-- couldn't be computed; due_month fixes that (NULL for monthly/weekly).
ALTER TABLE recurring_bills ADD COLUMN due_month int CHECK (due_month BETWEEN 1 AND 12);

-- Daily 09:00: alert 3 days before each subscription renews; on the 25th also
-- post the monthly subscriptions total. Reads personal subscription bills.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('r13.subs', 'Subscriptions',
   'Heads-up 3 days before each subscription renews, and on the 25th a monthly total of all your subscriptions (yearly ones spread per month).',
   '{expenses:read,slack:send}', 'cron:0 9 * * *', 'money',
   '{"workflowType":"subscriptionsWorkflow","cron":"0 9 * * *","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
