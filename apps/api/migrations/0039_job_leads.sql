-- A2.1 — Per-user job leads, ingested by A2.2 workers.
--
-- Idempotent per (user, source, source_id) so re-fetching the same Adzuna
-- feed doesn't duplicate rows. score + score_reason + status are nullable
-- and get filled in by A2.3 (classifier) and the UI (user action).
--
-- status transitions: new → saved → applied, or new → skipped.

CREATE TABLE job_leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  source         text NOT NULL,                       -- 'adzuna' | 'serpapi' | 'jsearch'
  source_id      text NOT NULL,                       -- external id in that source

  title          text NOT NULL,
  company        text,
  location       text,
  url            text NOT NULL,

  salary_min     numeric(12,2),
  salary_max     numeric(12,2),
  currency       text,
  salary_period  text,                                 -- 'yearly' | 'monthly' | NULL

  description    text,                                 -- snippet, used by LLM scorer

  posted_at      timestamptz,
  fetched_at     timestamptz NOT NULL DEFAULT now(),

  score          int CHECK (score IS NULL OR score BETWEEN 1 AND 5),
  score_reason   text,
  classified_at  timestamptz,

  status         text NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','saved','applied','skipped','interview','rejected')),

  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, source, source_id)
);

CREATE INDEX job_leads_user_idx         ON job_leads(user_id);
CREATE INDEX job_leads_status_idx       ON job_leads(status);
CREATE INDEX job_leads_score_idx        ON job_leads(score) WHERE score IS NOT NULL;
CREATE INDEX job_leads_fetched_at_idx   ON job_leads(fetched_at DESC);

ALTER TABLE job_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_leads_tenant ON job_leads
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON job_leads TO command_center_app;
