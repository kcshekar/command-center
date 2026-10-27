-- R12: monthly net-worth snapshot from the manual account balances (N9).
-- Assets = bank / investment / cash balances; liabilities = credit_card /
-- loan balances (entered as the amount owed). Personal zone, owner-only.
CREATE TABLE net_worth_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_on       date NOT NULL,
  assets_cents      bigint NOT NULL,
  liabilities_cents bigint NOT NULL,
  accounts_counted  int NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, snapshot_on)
);
ALTER TABLE net_worth_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY net_worth_snapshots_owner ON net_worth_snapshots USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON net_worth_snapshots TO command_center_app;

-- 1st of the month 08:00: take the snapshot, post it with the change since last month.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('r12.networth', 'Net worth',
   'On the 1st of each month: assets minus what you owe, from the balances on your personal accounts, and the change since last month.',
   '{expenses:write,slack:send}', 'cron:0 8 1 * *', 'money',
   '{"workflowType":"netWorthWorkflow","cron":"0 8 1 * *","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
