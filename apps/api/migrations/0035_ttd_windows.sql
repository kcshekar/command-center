-- A10.2 — TTD darshan windows the user wants reminders for.
--
-- One row per (desired darshan date + slot type). The worker's daily poll
-- (A10.3) scans release_at for anything opening in the next few hours and
-- Slacks a reminder with the pilgrim pack. Booking stays manual (catalog
-- description: "Does NOT auto-book").
--
-- pilgrim_ids is a plain uuid[] with no FK — Postgres can't FK array elements,
-- and deleting a pilgrim shouldn't cascade-delete every planned window.
-- Resolvers skip ids that no longer exist in pilgrim_identities.

CREATE TABLE ttd_windows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  darshan_date    date NOT NULL,                       -- the day you want darshan
  slot_type       text NOT NULL DEFAULT 'ssd',         -- 'ssd' | 'vip_break' | 'suprabhatam' | 'archana' | 'kalyanam' | 'other'
  release_at      timestamptz,                         -- when TTD opens bookings (usually darshan_date - 60d, 10:00 IST)

  status          text NOT NULL DEFAULT 'planned',     -- 'planned' | 'booked' | 'missed' | 'cancelled'
  booking_ref     text,                                -- booking id once booked

  pilgrim_ids     uuid[] NOT NULL DEFAULT '{}',        -- pilgrim_identities to pack for; see note above
  note            text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Last Slack ping, so the daily poll doesn't re-ping the same window every
  -- 6h once it has flipped into the imminent window.
  last_notified_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ttd_windows_user_idx       ON ttd_windows(user_id);
CREATE INDEX ttd_windows_release_idx    ON ttd_windows(release_at) WHERE status = 'planned';
CREATE INDEX ttd_windows_status_idx     ON ttd_windows(status);

ALTER TABLE ttd_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY ttd_windows_tenant ON ttd_windows
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON ttd_windows TO command_center_app;
