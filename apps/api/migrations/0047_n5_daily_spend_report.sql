-- N5: daily personal spend report (Tier 1).
--
-- New scope expenses:read — the first automation that reads money back. Every
-- read names a zone (GET /api/integrations/expenses/daily?zone=…), so personal
-- and business numbers can't mix by accident.
--
-- Worker clients mint tokens only for scopes in their allowed_scopes, and the
-- worker requests its full scope list on every call — so the scope must be
-- granted here or every worker call would 403. Granted only to clients that
-- already hold expenses:write (same data, read side).

UPDATE worker_clients
   SET allowed_scopes = array_append(allowed_scopes, 'expenses:read')
 WHERE 'expenses:write' = ANY(allowed_scopes)
   AND NOT ('expenses:read' = ANY(allowed_scopes));

-- No ui_route: its home is Finance, which is already a fixed sidebar item.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('n5.spend', 'Daily spend report',
   'Every evening at 21:00: today''s personal spending by category, flags any category above 2x its 30-day daily average, plus one locally drafted line. Nothing leaves your machine.',
   '{expenses:read,slack:send}', 'cron:0 21 * * *', 'money',
   '{"workflowType":"dailySpendReportWorkflow","cron":"0 21 * * *",
     "args":{"userId":"$userId","zone":"personal","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
