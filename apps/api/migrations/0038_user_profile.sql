-- A2.1 — Per-user profile the Jobs automation scores against.
--
-- Singleton per user (UNIQUE user_id). Structured fields are what the fetcher
-- uses to call the external APIs (keywords → query, location → geo filter);
-- the free-text bio is what the LLM reads when scoring each lead for fit.
--
-- Shared with org by convention is false — profile is personal. UI edits land
-- a single row via upsert on user_id.

CREATE TABLE user_profile (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  headline       text,                               -- 'Senior Backend Engineer'
  years_exp      int,
  location       text,                               -- 'Hyderabad, IN'
  remote_pref    text NOT NULL DEFAULT 'any',        -- 'remote' | 'hybrid' | 'onsite' | 'any'
  min_salary_lpa numeric(10,2),                      -- in min_salary_currency
  currency       text NOT NULL DEFAULT 'INR',

  skills         text[] NOT NULL DEFAULT '{}',       -- 'nodejs','postgres',...
  keywords       text[] NOT NULL DEFAULT '{}',       -- search terms for the fetcher
  anti_keywords  text[] NOT NULL DEFAULT '{}',       -- exclude terms

  bio            text,                               -- free-text; LLM context during scoring

  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_profile_tenant ON user_profile
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON user_profile TO command_center_app;
