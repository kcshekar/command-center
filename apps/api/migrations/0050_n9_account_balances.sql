-- N9: bill forecaster. Accounts had no balance; this is a manual figure the
-- owner updates in Finance (no bank access), with when it was last set.
ALTER TABLE accounts
  ADD COLUMN balance_cents bigint,
  ADD COLUMN balance_updated_at timestamptz;

-- Sunday 10:00: personal bills due in the next 30 days vs. the sum of
-- personal account balances; warns on a shortfall.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('n9.bills', 'Bill forecast',
   'Every Sunday: your bills due in the next 30 days against the balances you set on your accounts, with a warning if they don''t cover it.',
   '{expenses:read,slack:send}', 'cron:0 10 * * 0', 'money',
   '{"workflowType":"billForecastWorkflow","cron":"0 10 * * 0","args":{"userId":"$userId","days":30,"routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
