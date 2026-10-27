-- R10: monthly budget per spending category, personal only (private to the
-- owner, like personal expenses). Category matching is case-insensitive.
CREATE TABLE budgets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category            text NOT NULL,
  monthly_limit_cents bigint NOT NULL CHECK (monthly_limit_cents > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX budgets_owner_category_idx ON budgets (owner_user_id, lower(category));

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY budgets_owner ON budgets USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid
);
GRANT SELECT, INSERT, UPDATE, DELETE ON budgets TO command_center_app;

-- Friday 20:00: month-to-date spend per budgeted category vs. the limit
-- prorated to today. Pure SQL arithmetic, no AI.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('r10.budget', 'Budget check',
   'Every Friday evening: month-to-date spending per category against the budgets you set, prorated to today. Over budget is flagged.',
   '{expenses:read,slack:send}', 'cron:0 20 * * 5', 'money',
   '{"workflowType":"budgetReportWorkflow","cron":"0 20 * * 5","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
