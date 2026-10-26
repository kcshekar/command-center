-- A3/A4/A9 — Interview sessions + per-round tracker.
--
--   interview_sessions   — one row per (company × role) opportunity. A3.prep
--                          creates it on behalf of the user when they trigger
--                          "Prep" from a job_lead; the user can also create
--                          one manually from the UI.
--   interview_rounds     — per-round notes (phone screen, system design,
--                          behavioural, onsite, bar raiser, ...). User-driven
--                          mostly; A4.tracker surfaces reminders on upcoming
--                          scheduled_at.
--
-- source_job_lead_id ties back to A2 so the UI can jump to the posting.
-- NULL on manual sessions.

CREATE TABLE interview_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  company              text NOT NULL,
  role                 text NOT NULL,
  source_job_lead_id   uuid REFERENCES job_leads(id) ON DELETE SET NULL,

  status               text NOT NULL DEFAULT 'researching'
                       CHECK (status IN ('researching','applied','interviewing','offered','rejected','withdrawn')),
  applied_at           timestamptz,
  decision_at          timestamptz,

  notes                text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX interview_sessions_user_idx    ON interview_sessions(user_id);
CREATE INDEX interview_sessions_status_idx  ON interview_sessions(status);
CREATE INDEX interview_sessions_source_idx  ON interview_sessions(source_job_lead_id);

ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY interview_sessions_tenant ON interview_sessions
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON interview_sessions TO command_center_app;


CREATE TABLE interview_rounds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,

  kind            text NOT NULL                                  -- 'phone_screen' | 'technical' | 'system_design' | 'behavioral' | 'onsite' | 'bar_raiser' | 'other'
                  CHECK (kind IN ('phone_screen','technical','system_design','behavioral','onsite','bar_raiser','other')),
  scheduled_at    timestamptz,
  duration_min    int,
  interviewer     text,
  notes           text,
  outcome         text CHECK (outcome IS NULL OR outcome IN ('passed','failed','pending')),

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX interview_rounds_session_idx    ON interview_rounds(session_id);
CREATE INDEX interview_rounds_scheduled_idx  ON interview_rounds(scheduled_at) WHERE scheduled_at IS NOT NULL;

ALTER TABLE interview_rounds ENABLE ROW LEVEL SECURITY;
CREATE POLICY interview_rounds_tenant ON interview_rounds
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON interview_rounds TO command_center_app;
