-- Phase 1.6 — Prompt management.
--
--   prompts                — org defaults, admin-managed, one row per name
--   user_prompt_overrides  — per-user replacement of body / model / temperature
--
-- The automations (A1, A3, A5, A8, …) resolve a prompt by name through the
-- integration endpoint, which merges the user override on top of the default.
-- Keeping defaults org-visible lets any user see what the automation would run
-- without them (and tweak if they want). Admin-only writes on prompts are
-- enforced in app code via requireRole, not RLS — anyone in the org SELECTs
-- the defaults.

CREATE TABLE prompts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                text NOT NULL,                     -- slug, e.g. 'news_classifier'
  description         text,
  body                text NOT NULL,                     -- the actual system prompt
  variables           text[] NOT NULL DEFAULT '{}',      -- placeholder names the caller must fill
  default_model       text,                              -- e.g. 'claude-sonnet-5-5'
  default_temperature numeric(3,2),                      -- e.g. 0.70
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE INDEX prompts_name_idx ON prompts(name);

ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;
CREATE POLICY prompts_tenant ON prompts
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON prompts TO command_center_app;


CREATE TABLE user_prompt_overrides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt_name         text NOT NULL,                     -- matches prompts.name
  body                text NOT NULL,
  default_model       text,
  default_temperature numeric(3,2),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, prompt_name)
);

CREATE INDEX user_prompt_overrides_name_idx ON user_prompt_overrides(prompt_name);

ALTER TABLE user_prompt_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_prompt_overrides_tenant ON user_prompt_overrides
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON user_prompt_overrides TO command_center_app;
