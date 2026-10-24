-- A8.1 — Per-user list of "what I want to learn about this quarter". The
-- worker's weekly digest workflow (A8.2) iterates enabled rows and pulls
-- new material from each kind's upstream (GitHub releases, dev.to tag feed,
-- etc.) into knowledge_items.
--
-- Keep the schema small: one source + one target per row, unique per user so
-- toggling off/on is a lookup not a dedupe.

CREATE TABLE learning_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  source_kind   text NOT NULL,                        -- 'github_release' | 'dev_to_tag' | 'rss' | ...
  target        text NOT NULL,                        -- 'kubernetes/kubernetes' or 'rust' or feed URL
  weight        int  NOT NULL DEFAULT 3 CHECK (weight BETWEEN 1 AND 5),
  enabled       boolean NOT NULL DEFAULT true,

  note          text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, source_kind, target)
);

CREATE INDEX learning_goals_user_idx     ON learning_goals(user_id);
CREATE INDEX learning_goals_enabled_idx  ON learning_goals(enabled) WHERE enabled = true;

ALTER TABLE learning_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY learning_goals_tenant ON learning_goals
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON learning_goals TO command_center_app;
