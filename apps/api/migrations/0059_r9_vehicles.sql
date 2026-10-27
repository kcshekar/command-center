-- R9: vehicles with fuel and service logs, private to the owner. Fuel
-- efficiency uses consecutive full-tank fills; service is due by km or months.
CREATE TABLE vehicles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  service_every_km     int CHECK (service_every_km > 0),
  service_every_months int CHECK (service_every_months > 0),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vehicle_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('fuel', 'service')),
  logged_on     date NOT NULL,
  odometer_km   int NOT NULL CHECK (odometer_km >= 0),
  litres        numeric(7,2) CHECK (litres > 0),
  amount_cents  bigint CHECK (amount_cents >= 0),
  full_tank     boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_logs_vehicle_idx ON vehicle_logs (vehicle_id, logged_on DESC, odometer_km DESC);
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY vehicles_owner ON vehicles USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY vehicle_logs_owner ON vehicle_logs USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicles, vehicle_logs TO command_center_app;

-- Monday 09:00: service-due alerts; in the first week of a month also last
-- month's fuel spend and km/L.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, ui_route, ui_label, icon, schedule_template) VALUES
  ('r9.vehicle', 'Vehicle tracker',
   'Every Monday: a heads-up when a service is due (by km or months). In the first week of each month, last month''s fuel spend and mileage (km/L).',
   '{life:read,slack:send}', 'cron:0 9 * * 1', 'life', '/vehicles', 'Vehicles', 'car',
   '{"workflowType":"vehicleReportWorkflow","cron":"0 9 * * 1","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
