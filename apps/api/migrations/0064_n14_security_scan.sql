-- N14: weekly dependency security scan. Repo-level, so it's a system schedule
-- (n14-security-weekly in init-schedules.ts, owner/admin), not a per-user
-- grant; this row makes it visible in Automations.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area) VALUES
  ('n14.security', 'Security scan',
   'Every Monday: checks the dependency inventory (rebuilt only when lockfiles change) against OSV.dev. Minor/patch fixes become pull requests once GitHub is connected; major upgrades always ask you first.',
   '{slack:send}', 'cron:30 9 * * 1', 'platform')
ON CONFLICT (id) DO NOTHING;
