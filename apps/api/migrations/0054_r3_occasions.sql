-- R3: birthdays and anniversaries. Private to their owner (RLS), like
-- personal money. The year is optional (only used to say "turning 30").
CREATE TABLE occasions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person        text NOT NULL,
  relationship  text,
  kind          text NOT NULL DEFAULT 'birthday' CHECK (kind IN ('birthday', 'anniversary', 'other')),
  month         int NOT NULL CHECK (month BETWEEN 1 AND 12),
  day           int NOT NULL CHECK (day BETWEEN 1 AND 31),
  year          int CHECK (year BETWEEN 1900 AND 2100),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX occasions_owner_idx ON occasions (owner_user_id, month, day);

ALTER TABLE occasions ENABLE ROW LEVEL SECURITY;
CREATE POLICY occasions_owner ON occasions USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid
);
GRANT SELECT, INSERT, UPDATE, DELETE ON occasions TO command_center_app;

-- Worker read scope; same pattern as expenses:read (0047): worker clients
-- mint only allowed scopes and request all of theirs on every call.
UPDATE worker_clients
   SET allowed_scopes = array_append(allowed_scopes, 'occasions:read')
 WHERE 'knowledge:read' = ANY(allowed_scopes)
   AND NOT ('occasions:read' = ANY(allowed_scopes));

-- Daily 08:00: 7 days ahead → heads-up with gift ideas; on the day → a
-- drafted message. Gift ideas and drafts come from LOCAL Ollama only.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, ui_route, ui_label, icon, schedule_template) VALUES
  ('r3.occasions', 'Birthdays & anniversaries',
   'A week before: a heads-up with a few gift ideas. On the day: a short message draft to send. Ideas and drafts are written by your local model; names stay on your machine.',
   '{occasions:read,slack:send}', 'cron:0 8 * * *', 'life', '/occasions', 'Occasions', 'gift',
   '{"workflowType":"occasionsWorkflow","cron":"0 8 * * *","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
