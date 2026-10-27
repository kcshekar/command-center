-- R14: travel bookings found in Gmail by Mail dispatcher (deterministic
-- detector, details extracted by the LOCAL model). Owner-only; idempotent per
-- source email.
CREATE TABLE travel_bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('flight', 'train', 'bus', 'hotel', 'other')),
  provider          text,
  reference         text,              -- PNR / booking id; shown in full only in the app
  from_place        text,
  to_place          text,
  depart_at         timestamptz NOT NULL,  -- check-in time for hotels
  end_at            timestamptz,           -- arrival / check-out, when known
  source_message_id text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, source_message_id)
);
CREATE INDEX travel_bookings_owner_depart_idx ON travel_bookings (owner_user_id, depart_at);
ALTER TABLE travel_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY travel_bookings_owner ON travel_bookings USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON travel_bookings TO command_center_app;

UPDATE worker_clients
   SET allowed_scopes = array_append(allowed_scopes, 'travel:write')
 WHERE 'knowledge:write' = ANY(allowed_scopes)
   AND NOT ('travel:write' = ANY(allowed_scopes));

-- Hourly: bookings departing 23–24 hours from now get a trip pack (each trip
-- falls in exactly one hourly window). Bookings themselves are filed by Mail
-- dispatcher (a5.mail), so that must be on too.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, ui_route, ui_label, icon, schedule_template) VALUES
  ('r14.travel', 'Trip pack',
   'Mail dispatcher files flight, train, bus and hotel bookings from your Gmail; a day before you leave you get a trip pack. The booking reference is masked in Slack and shown in full on the Trips page.',
   '{life:read,slack:send}', 'cron:0 * * * *', 'life', '/travel', 'Trips', 'plane',
   '{"workflowType":"tripPackWorkflow","cron":"0 * * * *","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
