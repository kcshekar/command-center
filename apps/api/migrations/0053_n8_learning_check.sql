-- N8: weekly learning check. Reads A8's lessons and your learning goals
-- (existing knowledge:read / learning:read scopes); counts per goal, lists
-- must-reads, names goals that got nothing this week. No AI.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('n8.learncheck', 'Learning check',
   'Every Friday evening: what the Learning digest collected this week per goal, the must-reads, and which goals got nothing.',
   '{knowledge:read,learning:read,slack:send}', 'cron:0 19 * * 5', 'knowledge',
   '{"workflowType":"learningCheckWorkflow","cron":"0 19 * * 5","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
