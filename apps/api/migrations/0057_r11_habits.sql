-- R11: habits + daily check-ins, private to the owner. Logged from a
-- phone-friendly page (decision 2026-10-27); Slack only nudges and reports.
CREATE TABLE habits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE habit_logs (
  habit_id      uuid NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_on     date NOT NULL,
  PRIMARY KEY (habit_id, logged_on)           -- a row means "done that day"
);
ALTER TABLE habits ENABLE ROW LEVEL SECURITY;
ALTER TABLE habit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY habits_owner ON habits USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY habit_logs_owner ON habit_logs USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON habits, habit_logs TO command_center_app;

-- One worker read scope for the "life" trackers (habits, groceries, vehicles).
UPDATE worker_clients
   SET allowed_scopes = array_append(allowed_scopes, 'life:read')
 WHERE 'knowledge:read' = ANY(allowed_scopes)
   AND NOT ('life:read' = ANY(allowed_scopes));

-- Daily 21:00: nudge if today's habits aren't all logged; Sundays add the
-- weekly summary with streaks. Arithmetic only.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, ui_route, ui_label, icon, schedule_template) VALUES
  ('r11.habits', 'Habit check-in',
   'Every evening at 21:00, a nudge if today''s habits aren''t logged yet; on Sundays, your week and current streaks.',
   '{life:read,slack:send}', 'cron:0 21 * * *', 'life', '/habits', 'Habits', 'check-circle',
   '{"workflowType":"habitCheckinWorkflow","cron":"0 21 * * *","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
