-- Phase 1.1 of H5b: a user-visible catalog of automations plus a per-user
-- grant table. The catalog is global config (ids like 'a1.news', 'a2.jobs');
-- grants are per (org, user, automation) with an enabled flag, a jsonb config,
-- and an optional schedule override. Chaining targets live in the catalog so
-- the "which fires which" wiring can change without code edits.
--
-- Nothing reads these yet; subsequent steps add the catalog list endpoint
-- (1.2) and the enable/disable toggle (1.3). Automation workflows start
-- consulting grants when each automation ships.

CREATE TABLE automation_catalog (
  id               text PRIMARY KEY,                           -- 'a1.news', 'a2.jobs', ...
  name             text NOT NULL,
  description      text NOT NULL,
  required_scopes  text[] NOT NULL DEFAULT '{}',
  cadence_default  text,                                       -- 'cron:0 9 * * *' | 'event' | 'manual'
  chains_to        text[] NOT NULL DEFAULT '{}',               -- downstream catalog ids
  inputs_schema    jsonb NOT NULL DEFAULT '{}'::jsonb,         -- JSON Schema for grant.config
  default_enabled  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- No RLS: catalog is global. Writes happen only via migrations (admin seed).

CREATE TABLE automation_grants (
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  automation_id      text NOT NULL REFERENCES automation_catalog(id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT false,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule_override  text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, automation_id)
);

CREATE INDEX automation_grants_org_enabled_idx
  ON automation_grants(org_id, automation_id) WHERE enabled;
CREATE INDEX automation_grants_user_idx
  ON automation_grants(user_id) WHERE enabled;

ALTER TABLE automation_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY automation_grants_tenant ON automation_grants
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );
-- No FORCE: cc_admin owns the table and bypasses, matching the pattern
-- established by 0017/0018/0025.

GRANT SELECT                      ON automation_catalog TO command_center_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_grants  TO command_center_app;

-- Seed the catalog with the 12 automations from the plan. Everything stays
-- disabled by default; users opt in from the UI in step 1.3.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, chains_to) VALUES
  ('a1.news',      'Tech news post draft',
   'Twice-weekly LinkedIn-ready post drafted to Slack. You post manually.',
   '{slack:send,knowledge:read}',
   'cron:0 9 * * 1,4', '{}'),

  ('a2.jobs',      'Daily job feed',
   'Pulls jobs from Adzuna/SerpAPI/JSearch; filters and scores against your profile.',
   '{jobs:read,slack:send,knowledge:read}',
   'cron:0 9,18 * * *', '{a3.prep,a9.resume}'),

  ('a3.prep',      'Interview prep research',
   'Chained from A2 shortlist: verifies the posting, researches company and role.',
   '{interviews:write,knowledge:write}',
   'event', '{a4.tracker}'),

  ('a4.tracker',   'Interview session tracker',
   'Per-(company x role) sessions, rounds, notes, reminders.',
   '{interviews:read,interviews:write,calendar:read}',
   'manual', '{}'),

  ('a5.mail',      'Mail dispatcher',
   'Classifies Gmail every 15 minutes; routes to downstream automations.',
   '{mail:read,slack:send}',
   'cron:*/15 * * * *', '{a2.jobs,a4.tracker,a5.reply}'),

  ('a5.reply',     'Mail reply approval',
   'LLM drafts a reply; Slack approval; Gmail send on green.',
   '{mail:read,mail:send,slack:send}',
   'event', '{}'),

  ('a6.price',     'Price watcher',
   'Daily price checks per watch (Keepa for Amazon). Alerts to Slack.',
   '{prices:read,prices:write,slack:send}',
   'cron:0 7 * * *', '{}'),

  ('a7.profile',   'Monthly profile refresh',
   'Opens PRs to refresh GitHub README, portfolio, LinkedIn draft, resume.',
   '{github:write,slack:send,knowledge:read}',
   'cron:0 10 1 * *', '{a1.news}'),

  ('a8.learning',  'Weekly learning digest',
   'Weekly digest of certs, courses, releases tuned to your learning goals.',
   '{learning:read,slack:send,knowledge:read}',
   'cron:0 8 * * 1', '{}'),

  ('a9.resume',    'Per-job resume tailor',
   'Chained from A2: tailor resume plus cover letter plus Gmail draft.',
   '{resumes:write,mail:send,knowledge:read}',
   'event', '{a4.tracker}'),

  ('a10.ttd',      'TTD slot booking prep',
   'Monitors TTD release windows; reminders and pilgrim pack. Does NOT auto-book.',
   '{ttd:read,slack:send,pilgrim:read}',
   'cron:0 */6 * * *', '{}'),

  ('a11.upgrader', 'Self-upgrading agent',
   'Monthly scan; proposes model/framework/prompt upgrades. Review-only.',
   '{slack:send,platform:read}',
   'cron:0 11 1 * *', '{}');
